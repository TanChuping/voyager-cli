/**
 * Files a reply offers: the page hands each one over during its
 * `files.download` task (create → chunks → commit on `/v1/ext/blobs`), and
 * `ask`, `read` and `call files.download` save it under `output/files/`.
 */
import {
  BRIDGE_PATHS,
  bridgePath,
  MAX_BLOB_CHUNK_BYTES,
  type FileCandidate,
  type JobSubmitResponse,
  type ValidatedBridgeTask,
} from '@voyager-crew/bridge-protocol';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { askPlugin } from '../../plugins/ask/index';
import { UPDATE_FOR_FILES } from '../../plugins/shared/files';
import { presentResponse } from '../../plugins/shared/response';
import { parse, WAIT_OPTIONS } from '../../src/cli/args';
import { exitForJob } from '../../src/cli/exitCodes';
import type { JobDetail } from '../../src/jobs/jobStore';
import type { ForegroundContext } from '../../src/plugins/api';
import { isErrno } from '../../src/util/files';
import { sha256Hex } from '../../src/util/hash';
import {
  ASK_HANDLERS,
  FakeExtension,
  OpError,
  pairFake,
  type OpHandler,
} from '../helpers/fakeExtension';
import type { RawResponse } from '../helpers/http';
import { data, errorCode, startTestServer, until, type TestServer } from '../helpers/server';

const CONVERSATION = '6ad3f5e3-4464-83ed-8167-4abe151af1ff';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

function candidate(name: string, controlRef = `m-${name}`): FileCandidate {
  return { kind: 'sandbox', label: name, href: `sandbox:/mnt/data/${name}`, controlRef };
}

/** `turns.read` offering `files`, in reply order. */
function readWith(files: readonly FileCandidate[]): OpHandler {
  return () => ({
    markdown: 'Here you go',
    turnKey: 't-2',
    textSha256: sha256Hex('Here you go'),
    files,
  });
}

async function setup(handlers: Partial<Record<string, OpHandler>>) {
  t = await startTestServer();
  fake = new FakeExtension(t.port, { ...ASK_HANDLERS, ...handlers });
  await pairFake(fake, t.cli);
  fake.start();
  return { t, fake };
}

function createBlob(
  ext: FakeExtension,
  task: ValidatedBridgeTask,
  file: { name: string; size: number; sha256: string },
  ids: { jobId?: string; taskId?: string } = {},
): Promise<RawResponse> {
  return ext.request('POST', BRIDGE_PATHS.extBlobs, {
    jobId: ids.jobId ?? task.jobId,
    taskId: ids.taskId ?? task.taskId,
    mime: 'text/csv',
    ...file,
  });
}

function sendChunk(ext: FakeExtension, blobId: string, offset: number, bytes: Buffer) {
  return ext.request('POST', bridgePath.blob(blobId), {
    blobId,
    offset,
    base64: bytes.toString('base64'),
  });
}

/** What the page does for one file: create, chunks in order, commit, then the op result. */
async function handOver(
  ext: FakeExtension,
  task: ValidatedBridgeTask,
  name: string,
  bytes: Buffer,
  chunkBytes = 5,
) {
  const sha256 = sha256Hex(bytes);
  const created = await createBlob(ext, task, { name, size: bytes.length, sha256 });
  const { blobId } = data<{ blobId: string }>(created);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const sent = await sendChunk(ext, blobId, offset, bytes.subarray(offset, offset + chunkBytes));
    if (sent.status !== 200) throw new OpError('bad-request', JSON.stringify(sent.json));
  }
  data(await ext.request('POST', bridgePath.blobCommit(blobId)));
  return { blobId, name, size: bytes.length, sha256, mime: 'text/csv' };
}

async function submit(server: TestServer, plugin: 'ask' | 'read', input: unknown): Promise<string> {
  const response = await server.cli('POST', BRIDGE_PATHS.jobs, { plugin, command: plugin, input });
  return data<JobSubmitResponse>(response).jobId;
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

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

const ASK = { prompt: 'Make me a CSV', keepTab: false } as const;

describe('download blobs on /v1/ext/blobs', () => {
  it('refuses to create one unless its task is the running files.download of its job', async () => {
    const codes: Record<string, string | undefined> = {};
    const file = { name: 'a.csv', size: 1, sha256: sha256Hex('a') };
    const { t } = await setup({
      'turns.read': async (params, task, tools) => {
        codes.duringRead = errorCode(await createBlob(fake!, task, file));
        return readWith([candidate('a.csv')])(params, task, tools);
      },
      'files.download': async (_params, task) => {
        codes.otherTask = errorCode(await createBlob(fake!, task, file, { taskId: 't-other' }));
        codes.otherJob = errorCode(await createBlob(fake!, task, file, { jobId: 'j-other' }));
        return handOver(fake!, task, 'a.csv', Buffer.from('a'));
      },
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(codes).toEqual({ duringRead: 'gone', otherTask: 'gone', otherJob: 'gone' });
    expect(job.result?.files).toMatchObject([{ name: 'a.csv', size: 1 }]);
  });

  it('rejects a chunk out of order, one past the declared size, and any once its task ended', async () => {
    const seen: Record<string, RawResponse> = {};
    let leftOver = '';
    const { t } = await setup({
      'turns.read': readWith([candidate('a.csv')]),
      'files.download': async (_params, task) => {
        const created = await createBlob(fake!, task, {
          name: 'a.csv',
          size: 4,
          sha256: sha256Hex('abcd'),
        });
        const { blobId } = data<{ blobId: string }>(created);
        leftOver = blobId;
        seen.skipsAhead = await sendChunk(fake!, blobId, 2, Buffer.from('cd'));
        seen.tooLong = await sendChunk(fake!, blobId, 0, Buffer.from('abcde'));
        seen.first = await sendChunk(fake!, blobId, 0, Buffer.from('ab'));
        seen.repeated = await sendChunk(fake!, blobId, 0, Buffer.from('ab'));
        throw new OpError('selector-missing', 'the download button went away');
      },
      'conversation.close': async () => {
        seen.afterTask = await sendChunk(fake!, leftOver, 2, Buffer.from('cd'));
        seen.commitAfterTask = await fake!.request('POST', bridgePath.blobCommit(leftOver));
        return { closed: true };
      },
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(errorCode(seen.skipsAhead)).toBe('bad-request');
    expect(errorCode(seen.tooLong)).toBe('bad-request');
    expect(data(seen.first)).toEqual({ blobId: leftOver, received: 2 });
    expect(errorCode(seen.repeated)).toBe('bad-request');
    expect(errorCode(seen.afterTask)).toBe('gone');
    expect(errorCode(seen.commitAfterTask)).toBe('gone');
    // The half-written file did not outlive the job.
    expect(await entries(join(t.paths.jobs, job.jobId, 'incoming'))).toEqual([]);
  });

  it('accepts a chunk of the full MAX_BLOB_CHUNK_BYTES, larger than other JSON bodies', async () => {
    const bytes = Buffer.alloc(MAX_BLOB_CHUNK_BYTES, 7);
    const { t } = await setup({
      'turns.read': readWith([candidate('big.bin')]),
      'files.download': (_params, task) =>
        handOver(fake!, task, 'big.bin', bytes, MAX_BLOB_CHUNK_BYTES),
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(job.result?.failedFiles).toEqual([]);
    const [saved] = (job.result?.files ?? []) as { path: string; sha256: string }[];
    expect(saved.sha256).toBe(sha256Hex(bytes));
    expect((await readFile(saved.path)).equals(bytes)).toBe(true);
  });

  it('refuses a commit whose bytes do not match the declared sha256, and deletes them', async () => {
    let commit: RawResponse | undefined;
    let left: string[] = [];
    const { t } = await setup({
      'turns.read': readWith([candidate('a.csv')]),
      'files.download': async (_params, task) => {
        const created = await createBlob(fake!, task, {
          name: 'a.csv',
          size: 4,
          sha256: sha256Hex('abcd'),
        });
        const { blobId } = data<{ blobId: string }>(created);
        await sendChunk(fake!, blobId, 0, Buffer.from('abce'));
        commit = await fake!.request('POST', bridgePath.blobCommit(blobId));
        left = await entries(join(t.paths.jobs, task.jobId, 'incoming'));
        throw new OpError('hash-mismatch', 'serve refused the file');
      },
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(commit?.status).toBe(400);
    expect(errorCode(commit!)).toBe('hash-mismatch');
    expect(left).toEqual([]);
    expect(job.result?.failedFiles).toMatchObject([
      { label: 'a.csv', error: { code: 'hash-mismatch' } },
    ]);
  });
});

describe('the files a reply offers', () => {
  it('saves them under files/ beside response.md, adding -2 to a name already there', async () => {
    const contents = ['id,total\n1,2\n', 'id,total\n3,4\n'];
    let calls = 0;
    const { t, fake } = await setup({
      'turns.read': readWith([candidate('report.csv', 'm-1'), candidate('report.csv', 'm-2')]),
      'files.download': (_params, task) =>
        handOver(fake!, task, 'report.csv', Buffer.from(contents[calls++] ?? '')),
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(job.status).toBe('succeeded');
    const output = join(t.paths.jobs, job.jobId, 'output');
    expect(await entries(join(output, 'files'))).toEqual(['report-2.csv', 'report.csv']);
    expect(await readFile(join(output, 'files', 'report.csv'), 'utf8')).toBe(contents[0]);
    expect(await readFile(join(output, 'files', 'report-2.csv'), 'utf8')).toBe(contents[1]);
    expect(job.result?.files).toEqual([
      {
        name: 'report.csv',
        path: join(output, 'files', 'report.csv'),
        size: Buffer.byteLength(contents[0]),
        sha256: sha256Hex(contents[0]),
        mime: 'text/csv',
      },
      {
        name: 'report-2.csv',
        path: join(output, 'files', 'report-2.csv'),
        size: Buffer.byteLength(contents[1]),
        sha256: sha256Hex(contents[1]),
        mime: 'text/csv',
      },
    ]);
    // Each download names the reply it belongs to and its own control, in reply order.
    const downloads = fake.tasks.filter((task) => task.op === 'files.download');
    expect(downloads.map((task) => task.params)).toMatchObject([
      { conversationId: 'c-1', assistantTurnKey: 't-2', candidate: { controlRef: 'm-1' } },
      { conversationId: 'c-1', assistantTurnKey: 't-2', candidate: { controlRef: 'm-2' } },
    ]);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual([
      'response.md',
      'report.csv',
      'report-2.csv',
    ]);
    expect(await entries(join(t.paths.jobs, job.jobId, 'incoming'))).toEqual([]);
    expect(fake.protocolErrors).toEqual([]);
  });

  it('keeps the reply and the other files when one download fails, and still exits 0', async () => {
    const { t } = await setup({
      'turns.read': readWith([candidate('chart.png'), candidate('data.csv')]),
      'files.download': (params, task) => {
        const { candidate: offered } = params as { candidate: FileCandidate };
        if (offered.label === 'chart.png') throw new OpError('selector-missing', 'no such link');
        return handOver(fake!, task, 'data.csv', Buffer.from('1,2\n'));
      },
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(job.status).toBe('succeeded');
    expect(exitForJob(job)).toBe(0);
    expect(await readFile(String(job.result?.responsePath), 'utf8')).toBe('Here you go');
    expect(job.result?.files).toMatchObject([{ name: 'data.csv' }]);
    expect(job.result?.failedFiles).toMatchObject([
      {
        label: 'chart.png',
        href: 'sandbox:/mnt/data/chart.png',
        error: { code: 'selector-missing' },
      },
    ]);
  });

  it('stops after a download finds the tab gone, listing the rest as not tried', async () => {
    const { t, fake } = await setup({
      'turns.read': readWith([candidate('a.csv'), candidate('b.csv')]),
      'files.download': () => {
        throw new OpError('tab-closed', 'the tab was closed');
      },
    });
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(job.status).toBe('succeeded');
    expect(fake.tasks.filter((task) => task.op === 'files.download')).toHaveLength(1);
    expect(job.result?.failedFiles).toMatchObject([
      { label: 'a.csv', error: { code: 'tab-closed' } },
      {
        label: 'b.csv',
        error: { code: 'tab-closed', message: expect.stringContaining('not tried') },
      },
    ]);
  });

  it('ends cancelled, not succeeded, when the job is cancelled during a download', async () => {
    const { t } = await setup({
      'turns.read': readWith([candidate('a.csv')]),
      'files.download': async (_params, _task, tools) => {
        await until(() => tools.aborted());
        return {};
      },
    });
    const jobId = await submit(t, 'ask', ASK);
    await until(() => fake!.tasks.some((task) => task.op === 'files.download'));
    await t.cli('POST', bridgePath.jobCancel(jobId));
    const job = await finished(t, jobId);
    expect(job.status).toBe('cancelled');
  });

  it('downloads nothing with --no-files', async () => {
    const fg: ForegroundContext = {
      cwd: '/',
      stagingDir: () => Promise.reject(new Error('no staging in this test')),
      note: () => {},
      lastConversation: async () => undefined,
    };
    const def = askPlugin.commands.ask;
    const input = await def.prepare(
      fg,
      parse(['--no-files', 'Make me a CSV'], { ...WAIT_OPTIONS, ...def.options }),
    );
    const { t, fake } = await setup({ 'turns.read': readWith([candidate('a.csv')]) });
    const job = await finished(t, await submit(t, 'ask', input));
    expect(job.status).toBe('succeeded');
    expect(fake.tasks.map((task) => task.op)).not.toContain('files.download');
    expect(job.result?.files).toEqual([]);
    expect(await entries(join(t.paths.jobs, job.jobId, 'output', 'files'))).toEqual([]);
  });

  it('read downloads the files of the reply it read, keyed by that reply', async () => {
    const { t, fake } = await setup({
      'conversation.open': () => {
        const url = `https://chatgpt.com/c/${CONVERSATION}`;
        return {
          tabId: 7,
          url,
          docNonce: 'nonce-1',
          ready: { url, conversationId: CONVERSATION, loggedIn: true, mode: 'chat', evidence: {} },
        };
      },
      'turns.read': readWith([candidate('notes.md')]),
      'files.download': (_params, task) =>
        handOver(fake!, task, 'notes.md', Buffer.from('# Notes\n')),
    });
    const job = await finished(
      t,
      await submit(t, 'read', { conversationId: CONVERSATION, keepTab: false }),
    );
    expect(job.status).toBe('succeeded');
    expect(fake.tasks.find((task) => task.op === 'files.download')?.params).toMatchObject({
      conversationId: CONVERSATION,
      assistantTurnKey: 't-2',
    });
    expect(job.result?.files).toMatchObject([{ name: 'notes.md', size: 8 }]);
  });

  it('voyager call files.download saves the file and says where', async () => {
    const { t } = await setup({
      'files.download': (_params, task) => handOver(fake!, task, 'out.txt', Buffer.from('hi')),
    });
    const params = {
      conversationId: CONVERSATION,
      assistantTurnKey: 't-2',
      candidate: candidate('out.txt'),
    };
    const { jobId } = data<JobSubmitResponse>(
      await t.cli('POST', BRIDGE_PATHS.call, { op: 'files.download', params }),
    );
    const job = await finished(t, jobId);
    expect(job.status).toBe('succeeded');
    const saved = (job.result?.result ?? {}) as { path?: string };
    expect(saved.path).toBe(join(t.paths.jobs, jobId, 'output', 'files', 'out.txt'));
    expect(await readFile(saved.path!, 'utf8')).toBe('hi');
  });
});

describe('an extension without files.download (Voyager 2.1.1 and older)', () => {
  const offered = [candidate('a.csv'), candidate('b.csv')];

  async function expectReplyWithOneUpdateLine(job: JobDetail): Promise<void> {
    expect(job.status).toBe('succeeded');
    expect(exitForJob(job)).toBe(0);
    expect(await readFile(String(job.result?.responsePath), 'utf8')).toBe('Here you go');
    expect(job.result?.files).toEqual([]);
    expect(job.result?.failedFiles).toMatchObject([
      { label: 'a.csv', error: { code: 'unsupported-op', message: UPDATE_FOR_FILES } },
      { label: 'b.csv', error: { code: 'unsupported-op', message: UPDATE_FOR_FILES } },
    ]);
    const { notes } = presentResponse(job);
    expect(notes.filter((note) => note.includes('not downloaded'))).toEqual([
      `files not downloaded (2): ${UPDATE_FOR_FILES}`,
    ]);
  }

  it('saves the reply and says once to update when the op is not declared', async () => {
    const { t, fake } = await setup({ 'turns.read': readWith(offered) });
    fake.ops = fake.ops.filter((op) => op.name !== 'files.download');
    const job = await finished(t, await submit(t, 'ask', ASK));
    expect(fake.tasks.map((task) => task.op)).not.toContain('files.download');
    await expectReplyWithOneUpdateLine(job);
  });

  it('saves the reply and says once to update when the page answers unsupported-op', async () => {
    // No handler: the fake answers unsupported-op, as a 2.1.1 page does for an op it does not run.
    const { t, fake } = await setup({ 'turns.read': readWith(offered) });
    const job = await finished(
      t,
      await submit(t, 'read', { conversationId: CONVERSATION, keepTab: false }),
    );
    expect(fake.tasks.filter((task) => task.op === 'files.download')).toHaveLength(1);
    await expectReplyWithOneUpdateLine(job);
  });
});
