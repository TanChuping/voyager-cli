import {
  BRIDGE_PATHS,
  bridgePath,
  type BlobRef,
  type JobSubmitResponse,
} from '@voyager-crew/bridge-protocol';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../../src/jobs/blobStore';
import type { JobDetail } from '../../src/jobs/jobStore';
import { stageAttachments, type StagedAttachment } from '../../src/util/attach/stage';
import { BridgeFailure } from '../../src/util/errors';
import { ASK_HANDLERS, FakeExtension, OpError, pairFake } from '../helpers/fakeExtension';
import type { RawResponse } from '../helpers/http';
import {
  data,
  errorCode,
  startTestServer,
  tempHome,
  until,
  type TestServer,
} from '../helpers/server';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
const made: string[] = [];
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function stagedFolder(staging: string): Promise<StagedAttachment> {
  const parent = await mkdtemp(join(tmpdir(), 'voyager-proj-'));
  made.push(parent);
  const root = join(parent, 'proj');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'console.log("hi");\n'.repeat(2000));
  await writeFile(join(root, '.env'), 'TOKEN=1');
  const dir = join(staging, 'job-test');
  await mkdir(dir, { recursive: true });
  const [staged] = await stageAttachments([root], {
    cwd: '/',
    stagingDir: async () => dir,
    note: () => {},
  });
  return staged;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof BridgeFailure ? error.code : String(error);
  }
  return undefined;
}

function readChunk(ext: FakeExtension, blobId: string, offset: number, length: number) {
  return ext.request('POST', bridgePath.blobRead(blobId), { offset, length });
}

async function finished(server: TestServer, jobId: string): Promise<JobDetail> {
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return ['succeeded', 'failed', 'cancelled', 'needs-user', 'detached'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

describe('BlobStore.register', () => {
  it('takes a staged file into the job and hashes the copy it serves', async () => {
    const paths = await tempHome();
    made.push(paths.home);
    const staged = await stagedFolder(paths.staging);
    const store = new BlobStore(paths, (jobId) => join(paths.jobs, jobId));
    const blob = await store.register('j1', staged.path, {
      name: staged.name,
      size: staged.size,
      sha256: staged.sha256,
    });
    expect(blob).toMatchObject({ name: 'proj.zip', size: staged.size, sha256: staged.sha256 });
    expect(await readdir(join(paths.jobs, 'j1', 'input'))).toEqual(['proj.zip']);
    expect(await readdir(paths.staging)).toEqual([]); // its staging folder went with it
  });

  it('refuses a path outside the staging folder, and a symlink out of it', async () => {
    const paths = await tempHome();
    made.push(paths.home);
    const outside = join(paths.home, 'elsewhere.zip');
    await writeFile(outside, 'x');
    const store = new BlobStore(paths, (jobId) => join(paths.jobs, jobId));
    expect(await codeOf(store.register('j1', outside))).toBe('path-unsafe');
    expect(await codeOf(store.register('j1', join(paths.staging, '..', 'elsewhere.zip')))).toBe(
      'path-unsafe',
    );
    await symlink(outside, join(paths.staging, 'link.zip'));
    expect(await codeOf(store.register('j1', join(paths.staging, 'link.zip')))).toBe('path-unsafe');
  });

  it('refuses a staged file that changed after it was packed', async () => {
    const paths = await tempHome();
    made.push(paths.home);
    const staged = await stagedFolder(paths.staging);
    await writeFile(staged.path, 'tampered');
    const store = new BlobStore(paths, (jobId) => join(paths.jobs, jobId));
    const code = await codeOf(
      store.register('j1', staged.path, { size: staged.size, sha256: staged.sha256 }),
    );
    expect(code).toBe('hash-mismatch');
  });
});

describe('ask --attach', () => {
  it('attaches the zip, then sends with it expected and explained; chunks match the sha256', async () => {
    t = await startTestServer();
    const server = t;
    const ext = new FakeExtension(server.port, { ...ASK_HANDLERS });
    fake = ext;
    await pairFake(ext, server.cli);
    const staged = await stagedFolder(server.paths.staging);

    const seen: { attach?: BlobRef[]; outOfRange?: RawResponse; duringSend?: RawResponse } = {};
    let sendParams: { text?: string; expectAttachments?: string[] } = {};
    ext.handlers['composer.attach'] = async (params) => {
      const { blobs } = params as { blobs: BlobRef[] };
      seen.attach = blobs;
      const [blob] = blobs;
      const parts: Buffer[] = [];
      for (let offset = 0; offset < blob.size; offset += 4096) {
        const length = Math.min(4096, blob.size - offset);
        const reply = await readChunk(ext, blob.blobId, offset, length);
        const chunk = (reply.json as { data: { base64: string } }).data;
        parts.push(Buffer.from(chunk.base64, 'base64'));
      }
      if (createHash('sha256').update(Buffer.concat(parts)).digest('hex') !== blob.sha256) {
        throw new OpError('hash-mismatch');
      }
      seen.outOfRange = await readChunk(ext, blob.blobId, blob.size - 1, 2);
      return { attached: [{ name: blob.name, method: 'input' }], evidence: {} };
    };
    ext.handlers['composer.send'] = async (params, task) => {
      sendParams = params as typeof sendParams;
      seen.duringSend = await readChunk(ext, seen.attach?.[0]?.blobId ?? 'x', 0, 1);
      return ASK_HANDLERS['composer.send']?.(params, task, {
        progress: async () => {},
        aborted: () => false,
      });
    };
    ext.start();

    const submitted = await server.cli('POST', BRIDGE_PATHS.jobs, {
      plugin: 'ask',
      command: 'ask',
      input: { prompt: 'Review this', keepTab: false, attachments: [staged] },
    });
    const { jobId } = data<JobSubmitResponse>(submitted);
    const job = await finished(server, jobId);
    expect(job.status).toBe('succeeded');
    expect(seen.attach?.map((blob) => [blob.name, blob.size, blob.sha256])).toEqual([
      ['proj.zip', staged.size, staged.sha256],
    ]);
    expect(sendParams.expectAttachments).toEqual(['proj.zip']);
    expect(sendParams.text).toBe(
      'Review this\n\n(proj.zip is a zip of the local folder proj, 1 file.)',
    );
    expect(job.checkpoints.attached).toMatchObject({ names: ['proj.zip'] });
    // Only the job's own attach task may read its blob, and only inside the blob.
    expect(seen.outOfRange?.status).toBe(400);
    expect(errorCode(seen.duringSend!)).toBe('gone');
    expect(errorCode(await readChunk(ext, seen.attach![0].blobId, 0, 1))).toBe('not-found');
    expect(ext.protocolErrors).toEqual([]);
  });

  it('ends the job before opening a tab when a staged attachment changed', async () => {
    t = await startTestServer();
    const server = t;
    const ext = new FakeExtension(server.port, { ...ASK_HANDLERS });
    fake = ext;
    await pairFake(ext, server.cli);
    const staged = await stagedFolder(server.paths.staging);
    await writeFile(staged.path, 'tampered');
    ext.start();
    const { jobId } = data<JobSubmitResponse>(
      await server.cli('POST', BRIDGE_PATHS.jobs, {
        plugin: 'ask',
        command: 'ask',
        input: { prompt: 'Review this', keepTab: false, attachments: [staged] },
      }),
    );
    const job = await finished(server, jobId);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('hash-mismatch');
    expect(ext.tasks).toEqual([]);
  });
});
