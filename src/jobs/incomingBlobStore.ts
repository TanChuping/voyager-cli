import {
  base64DecodedLength,
  MAX_BLOB_CHUNK_BYTES,
  type BlobChunk,
  type BlobCommitResponse,
  type BlobCreateRequest,
  type BlobRef,
} from '@voyager-crew/bridge-protocol';
/**
 * Download blobs: files a reply offers, which the page fetches during a
 * `files.download` task and posts here (`POST /v1/ext/blobs`, chunks to
 * `/v1/ext/blobs/:id`, then `/commit`). Each is written to
 * `jobs/<id>/incoming/<blobId>.part` as its chunks arrive, in order, and is
 * hashed on the way in; commit checks size and sha256 against what create
 * declared. The job then `take`s a committed blob into `output/files/`.
 *
 * Chunks are accepted only while the task that created the blob is the one in
 * the slot (see `routes/ext.ts`); whatever a job did not take is deleted when
 * it ends.
 */
import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SavedFile } from '../plugins/api';
import { failure } from '../util/errors';
import { isErrno, removeFile } from '../util/files';
import { newId } from '../util/ids';
import { sanitizeFileName, uniqueName } from '../util/sanitizeName';

/**
 * Largest file a reply may hand over. ChatGPT caps a file at 512 MB, and a
 * code-interpreter file is written under that cap; the bound keeps a runaway
 * or hostile page from filling the disk through a paired extension.
 */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

interface IncomingBlob {
  readonly blobId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly mime: string;
  readonly path: string;
  readonly hash: Hash;
  received: number;
  /** A chunk is being written: the next one has to wait for its answer. */
  writing: boolean;
  committed: boolean;
}

const OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

export class IncomingBlobStore {
  private readonly blobs = new Map<string, IncomingBlob>();

  constructor(private readonly jobDir: (jobId: string) => string) {}

  /** The caller checked that `request.taskId` is the running `files.download` of `request.jobId`. */
  async create(request: BlobCreateRequest): Promise<string> {
    if (request.size > MAX_DOWNLOAD_BYTES) {
      throw failure('attachment-too-large', 'the file is over the download limit', {
        size: request.size,
        limit: MAX_DOWNLOAD_BYTES,
      });
    }
    // One unfinished download per job: a retry, or the next file after a failed one, drops it.
    for (const blob of this.blobs.values()) {
      if (blob.jobId === request.jobId && !blob.committed) await this.drop(blob);
    }
    const dir = join(this.jobDir(request.jobId), 'incoming');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const blobId = newId('d');
    const path = join(dir, `${blobId}.part`);
    await (await open(path, OPEN_FLAGS, 0o600)).close();
    this.blobs.set(blobId, {
      blobId,
      jobId: request.jobId,
      taskId: request.taskId,
      name: sanitizeFileName(request.name),
      size: request.size,
      sha256: request.sha256,
      mime: request.mime,
      path,
      hash: createHash('sha256'),
      received: 0,
      writing: false,
      committed: false,
    });
    return blobId;
  }

  /** The job and task a blob belongs to, for the route's check against the slot. */
  owner(blobId: string): { readonly jobId: string; readonly taskId: string } | undefined {
    const blob = this.blobs.get(blobId);
    return blob && { jobId: blob.jobId, taskId: blob.taskId };
  }

  /** Append one chunk; it must start where the bytes received so far end. */
  async append(chunk: BlobChunk): Promise<{ readonly received: number }> {
    const blob = this.require(chunk.blobId);
    if (blob.committed) throw failure('gone', 'the blob is already committed');
    if (blob.writing)
      throw failure('bad-request', 'another chunk of this blob is still being written');
    if (chunk.offset !== blob.received) {
      throw failure(
        'bad-request',
        `the chunk starts at ${chunk.offset}, expected ${blob.received}`,
        {
          received: blob.received,
        },
      );
    }
    const length = base64DecodedLength(chunk.base64);
    if (length === undefined || length > MAX_BLOB_CHUNK_BYTES) {
      throw failure('bad-request', `a chunk holds at most ${MAX_BLOB_CHUNK_BYTES} bytes`);
    }
    if (blob.received + length > blob.size) {
      throw failure('bad-request', 'the chunk runs past the declared size', {
        size: blob.size,
        received: blob.received,
      });
    }
    const bytes = Buffer.from(chunk.base64, 'base64');
    blob.writing = true;
    try {
      const handle = await open(blob.path, constants.O_WRONLY | constants.O_APPEND);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A short write leaves the file out of step with `received`: nothing can follow it.
      await this.drop(blob);
      throw error;
    } finally {
      blob.writing = false;
    }
    blob.received += bytes.length;
    blob.hash.update(bytes);
    return { received: blob.received };
  }

  /** Check the whole file against create; a mismatch deletes it. Repeating a commit answers the same. */
  async commit(blobId: string): Promise<BlobCommitResponse> {
    const blob = this.require(blobId);
    if (blob.writing) throw failure('bad-request', 'a chunk of this blob is still being written');
    if (!blob.committed) {
      const sha256 = blob.received === blob.size ? blob.hash.digest('hex') : undefined;
      if (sha256 !== blob.sha256) {
        await this.drop(blob);
        throw failure('hash-mismatch', `${blob.name} does not match its declared size and sha256`, {
          expected: { size: blob.size, sha256: blob.sha256 },
          observed: { size: blob.received, ...(sha256 === undefined ? {} : { sha256 }) },
        });
      }
      blob.committed = true;
    }
    return { blobId, size: blob.size, sha256: blob.sha256 };
  }

  /**
   * Move a committed blob of `jobId` into `dir` under `name` (sanitized), or
   * `stem-2.ext`… when that is taken: an existing file is never replaced.
   * `expected` is what the op result says it handed over.
   */
  async take(jobId: string, expected: BlobRef, dir: string, name: string): Promise<SavedFile> {
    const blob = this.blobs.get(expected.blobId);
    if (blob === undefined || blob.jobId !== jobId) {
      throw failure('not-found', `no downloaded blob ${expected.blobId} in this job`);
    }
    if (!blob.committed) throw failure('bad-request', `${blob.name} was never committed`);
    if (expected.size !== blob.size || expected.sha256 !== blob.sha256) {
      throw failure('hash-mismatch', `${blob.name} is not the file the page reported`, {
        expected: { size: expected.size, sha256: expected.sha256 },
        observed: { size: blob.size, sha256: blob.sha256 },
      });
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const wanted = sanitizeFileName(name === '' ? blob.name : name);
    const taken = new Set((await readdir(dir)).map((entry) => entry.toLowerCase()));
    for (;;) {
      const chosen = uniqueName(wanted, taken);
      const path = join(dir, chosen);
      try {
        // `link` refuses an existing name, where `rename` would replace it.
        await link(blob.path, path);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        taken.add(chosen.toLowerCase());
        continue;
      }
      this.blobs.delete(blob.blobId);
      await removeFile(blob.path);
      return { path, name: chosen, size: blob.size, sha256: blob.sha256 };
    }
  }

  /** Delete everything of `jobId` that was not taken, finished or not. */
  async forgetJob(jobId: string): Promise<void> {
    for (const [blobId, blob] of this.blobs) if (blob.jobId === jobId) this.blobs.delete(blobId);
    await rm(join(this.jobDir(jobId), 'incoming'), { recursive: true, force: true });
  }

  private require(blobId: string): IncomingBlob {
    const blob = this.blobs.get(blobId);
    if (blob === undefined) throw failure('not-found', 'no such blob');
    return blob;
  }

  private async drop(blob: IncomingBlob): Promise<void> {
    this.blobs.delete(blob.blobId);
    await removeFile(blob.path);
  }
}
