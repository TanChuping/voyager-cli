import { BRIDGE_PATHS, bridgePath, type JobSubmitResponse } from '@voyager-crew/bridge-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { parseApproveApps } from '../../plugins/ask/approval';
import { exitForJob } from '../../src/cli/exitCodes';
import type { JobDetail } from '../../src/jobs/jobStore';
import { ASK_HANDLERS, FakeExtension, OpError, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, until, type TestServer } from '../helpers/server';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

const CARD = {
  app: 'Google Drive',
  text: '允许 ChatGPT 使用 Google Drive 吗？',
  choices: ['always', 'once'],
};
const asksApproval = () => {
  throw new OpError('approval-required', 'ChatGPT asks to allow one of its apps', CARD);
};

async function setup() {
  t = await startTestServer();
  fake = new FakeExtension(t.port, { ...ASK_HANDLERS });
  await pairFake(fake, t.cli);
  return { t, fake };
}

async function askAndFinish(server: TestServer, extra: Record<string, unknown> = {}) {
  const { jobId } = data<JobSubmitResponse>(
    await server.cli('POST', BRIDGE_PATHS.jobs, {
      plugin: 'ask',
      command: 'ask',
      input: { prompt: 'save this to my Drive', keepTab: false, ...extra },
    }),
  );
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return ['succeeded', 'failed', 'cancelled', 'needs-user', 'detached'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

describe("ChatGPT's app approval card", () => {
  it('stops with exit 3 and where to answer it, when the run was not told to answer', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.waitReply'] = asksApproval;
    fake.start();
    const job = await askAndFinish(t);
    expect(job.status).toBe('needs-user');
    expect(exitForJob(job)).toBe(3);
    expect(job.error?.code).toBe('approval-required');
    expect(job.error?.message).toContain('Google Drive');
    expect(job.error?.message).toContain('https://chatgpt.com/c/c-1');
    expect(job.error?.message).toContain('--approve-apps');
    expect(fake.tasks.find((task) => task.op === 'turns.waitReply')?.params).toMatchObject({
      stopOnApproval: true,
    });
    expect(fake.tasks.map((task) => task.op)).not.toContain('turns.approve');
  });

  it('clicks Always allow and goes on waiting for the reply with --approve-apps always', async () => {
    const { t, fake } = await setup();
    let waits = 0;
    fake.handlers['turns.waitReply'] = (params, task, tools) => {
      waits += 1;
      return waits === 1 ? asksApproval() : ASK_HANDLERS['turns.waitReply']!(params, task, tools);
    };
    fake.handlers['turns.approve'] = () => ({ clicked: true, app: 'Google Drive', evidence: {} });
    fake.start();
    const job = await askAndFinish(t, { approveApps: 'always' });
    expect(job.status).toBe('succeeded');
    const ops = fake.tasks.map((task) => task.op);
    expect(ops.slice(ops.indexOf('turns.waitReply'))).toEqual([
      'turns.waitReply',
      'turns.approve',
      'turns.waitReply',
      'turns.read',
      'conversation.close',
    ]);
    expect(fake.tasks.find((task) => task.op === 'turns.approve')?.params).toMatchObject({
      conversationId: 'c-1',
      afterUserTurnKey: 't-1',
      choice: 'always',
    });
  });

  it('stops answering a page that keeps asking, instead of clicking forever', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.waitReply'] = asksApproval;
    fake.handlers['turns.approve'] = () => ({ clicked: true, app: 'Google Drive', evidence: {} });
    fake.start();
    const job = await askAndFinish(t, { approveApps: 'once' });
    expect(job.status).toBe('needs-user');
    expect(job.error?.code).toBe('approval-required');
    expect(fake.tasks.filter((task) => task.op === 'turns.approve')).toHaveLength(10);
    expect(fake.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
  });

  it('takes only always or once for --approve-apps', () => {
    expect(parseApproveApps(undefined)).toBeUndefined();
    expect(parseApproveApps('always')).toBe('always');
    expect(parseApproveApps('once')).toBe('once');
    expect(() => parseApproveApps('deny')).toThrow(/always or once/);
  });
});
