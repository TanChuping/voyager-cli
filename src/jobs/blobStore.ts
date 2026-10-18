import { MAX_ATTACHMENT_BYTES, type BlobRef } from '@voyager-crew/bridge-protocol';
/**
 * Upload blobs (spec §2.7): files a job hands the page through
 * `composer.attach`. A foreground command stages them under
 * `~/.voyager/staging/`; `register` accepts only a regular file there (no
 * symlink, nothing outside), moves it into `jobs/<id>/input/`, and hashes the
 * moved copy, so what the page later checks is exactly what serve serves.
 *
 * The extension reads chunks only while its job's `composer.attach` task
 * holds the slot (see `routes/ext.ts`); a job's blobs are forgotten when it
 * ends.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

import type { BlobRegisterOptions } from '../plugins/api';
import type { StatePaths } from '../state/paths';
import { failure } from '../util/errors';
import { newId } from '../util/ids';
import { mimeFor } from '../util/mime';
import { sanitizeFileName, uniqueName } from '../util/sanitizeName';

export interface StoredBlob extends BlobRef {
  readonly jobId: string;
  readonly path: string;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

export class BlobStore {
  private readonly blobs = new Map<string, StoredBlob>();

  constructor(
    private readonly paths: StatePaths,
    private readonly jobDir: (jobId: string) => string,
  ) {}

  async register(
    jobId: string,
    stagedPath: string,
    options: BlobRegisterOptions = {},
  ): Promise<BlobRef> {
    await mkdir(this.paths.staging, { recursive: true, mode: 0o700 });
    const root = await realpath(this.paths.staging);
    let real: string;
    let link;
    try {
      link = await lstat(stagedPath);
      real = await realpath(stagedPath);
    } catch {
      throw failure('bad-request', `the staged attachment ${basename(stagedPath)} is missing`);
    }
    if (link.isSymbolicLink() || !real.startsWith(root + sep)) {
      throw failure('path-unsafe', 'attachments must be staged by voyager itself');
    }
    const stats = await lstat(real);
    if (!stats.isFile()) throw failure('path-unsafe', 'a staged attachment must be a regular file');
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw failure('attachment-too-large', 'the attachment is over the upload limit', {
        size: stats.size,
        limit: MAX_ATTACHMENT_BYTES,
      });
    }

    const inputDir = join(this.jobDir(jobId), 'input');
    await mkdir(inputDir, { recursive: true, mode: 0o700 });
    const taken = new Set((await readdir(inputDir)).map((entry) => entry.toLowerCase()));
    const name = uniqueName(sanitizeFileName(options.name ?? basename(real)), taken);
    const path = join(inputDir, name);
    await rename(real, path);
    const stagingFolder = dirname(real);
    if (stagingFolder !== root) await rmdir(stagingFolder).catch(() => undefined);

    // Hash the copy serve owns now: a change to the staged file after this cannot reach the page.
    const size = (await lstat(path)).size;
    const sha256 = await sha256Of(path);
    if (
      (options.size !== undefined && options.size !== size) ||
      (options.sha256 !== undefined && options.sha256 !== sha256)
    ) {
      throw failure('hash-mismatch', `${name} changed after it was packed`, {
        expected: { size: options.size, sha256: options.sha256 },
        observed: { size, sha256 },
      });
    }
    const blob: StoredBlob = {
      blobId: newId('b'),
      name,
      size,
      sha256,
      mime: options.mime ?? mimeFor(name),
      jobId,
      path,
    };
    this.blobs.set(blob.blobId, blob);
    return { blobId: blob.blobId, name, size, sha256, mime: blob.mime };
  }

  get(blobId: string): StoredBlob | undefined {
    return this.blobs.get(blobId);
  }

  /** `length` bytes at `offset`; the caller has checked the range against the blob's size. */
  async read(blob: StoredBlob, offset: number, length: number): Promise<Buffer> {
    const handle = await open(blob.path, 'r');
    try {
      if ((await handle.stat()).size !== blob.size) {
        throw failure('hash-mismatch', `${blob.name} changed on disk`);
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length)
        throw failure('hash-mismatch', `${blob.name} is shorter than registered`);
      return buffer;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  forgetJob(jobId: string): void {
    for (const [blobId, blob] of this.blobs) if (blob.jobId === jobId) this.blobs.delete(blobId);
  }
}
