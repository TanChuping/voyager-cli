import {
  BRIDGE_PATHS,
  bridgePath,
  type JobEventsResponse,
  type JobSubmitResponse,
} from '@voyager-crew/bridge-protocol';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { exitForJob } from '../../src/cli/exitCodes';
import type { JobDetail } from '../../src/jobs/jobStore';
import { writeJsonAtomic } from '../../src/util/files';
import { ASK_HANDLERS, FakeExtension, OpError, pairFake } from '../helpers/fakeExtension';
import { data, errorCode, startTestServer, until, type TestServer } from '../helpers/server';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

async function setup(overrides: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer(overrides);
  fake = new FakeExtension(t.port, { ...ASK_HANDLERS });
  await pairFake(fake, t.cli);
  return { t, fake };
}

async function submitAsk(server: TestServer, prompt = 'Reply with OK') {
  return server.cli('POST', BRIDGE_PATHS.jobs, {
    plugin: 'ask',
    command: 'ask',
    input: { prompt, keepTab: false },
  });
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

async function events(server: TestServer, jobId: string) {
  return data<JobEventsResponse>(await server.cli('GET', `${bridgePath.jobEvents(jobId)}?after=0`))
    .events;
}

describe('single job slot', () => {
  it('lets exactly one of several concurrent submits through; the rest are busy, not queued', async () => {
    const { t } = await setup();
    const responses = await Promise.all(Array.from({ length: 6 }, () => submitAsk(t)));
    const accepted = responses.filter((response) => response.status === 202);
    const refused = responses.filter((response) => response.status === 409);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(5);
    const { jobId } = data<JobSubmitResponse>(accepted[0]);
    for (const response of refused) {
      expect(errorCode(response)).toBe('busy');
      expect(
        (response.json as { error: { details: { activeJobId: string } } }).error.details
          .activeJobId,
      ).toBe(jobId);
    }
    const call = await t.cli('POST', BRIDGE_PATHS.call, { op: 'model.inspect', params: {} });
    expect(call.status).toBe(409);
    const { jobs } = data<{ jobs: unknown[] }>(await t.cli('GET', BRIDGE_PATHS.jobs));
    expect(jobs).toHaveLength(1);
  });

  it('refuses a job when nothing is paired', async () => {
    t = await startTestServer();
    const response = await submitAsk(t);
    expect(errorCode(response)).toBe('not-paired');
    expect(response.status).toBe(412);
  });
});

describe('job state machine', () => {
  it('runs ask to succeeded and writes response.md, passing waiting-reply on the way', async () => {
    const { t, fake } = await setup();
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    const job = await finished(t, jobId);
    expect(job.status).toBe('succeeded');
    expect(exitForJob(job)).toBe(0);
    const responsePath = String(job.result?.responsePath);
    expect(responsePath).toBe(join(t.paths.jobs, jobId, 'output', 'response.md'));
    expect(await readFile(responsePath, 'utf8')).toBe('OK');
    expect(job.result?.response).toMatchObject({ markdown: 'OK', untrusted: true });
    expect(job.checkpoints.sent).toMatchObject({ conversationId: 'c-1', userTurnKey: 't-1' });

    const statuses = (await events(t, jobId))
      .filter((e) => e.type === 'status')
      .map((e) => e.data.status);
    expect(statuses).toEqual(['running', 'waiting-reply', 'running', 'succeeded']);
    expect(fake.tasks.map((task) => task.op)).toEqual([
      'conversation.open',
      'composer.send',
      'turns.waitReply',
      'turns.read',
      'conversation.close',
    ]);
    expect(fake.protocolErrors).toEqual([]);
    const persisted = JSON.parse(await readFile(join(t.paths.jobs, jobId, 'job.json'), 'utf8'));
    expect(persisted.status).toBe('succeeded');
  });

  it('ends in needs-user when the page needs a person, and sends nothing after', async () => {
    const { t, fake } = await setup();
    fake.handlers['conversation.open'] = () => {
      throw new OpError('challenge');
    };
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    const job = await finished(t, jobId);
    expect(job.status).toBe('needs-user');
    expect(job.error?.code).toBe('challenge');
    expect(exitForJob(job)).toBe(3);
    expect(fake.tasks.map((task) => task.op)).toEqual(['conversation.open']);
  });

  it('is detached, not failed or retried, when waiting for the reply times out after the send', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.waitReply'] = () => {
      throw new OpError('timeout');
    };
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    const job = await finished(t, jobId);
    expect(job.status).toBe('detached');
    expect(job.checkpoints.sent).toMatchObject({ conversationId: 'c-1' });
    expect(fake.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
  });

  it('cancels during the reply wait: abort reaches the extension and the next job can run', async () => {
    const { t, fake } = await setup();
    let release: () => void = () => {};
    fake.handlers['turns.waitReply'] = () =>
      new Promise<never>((_resolve, reject) => {
        release = () => reject(new OpError('cancelled'));
      });
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    await until(() => fake.tasks.some((task) => task.op === 'turns.waitReply'));
    const cancelled = data<JobDetail>(await t.cli('POST', bridgePath.jobCancel(jobId)));
    expect(cancelled.status).toBe('cancelling');

    const job = await finished(t, jobId);
    expect(job.status).toBe('cancelled');
    expect(job.checkpoints.sent).toMatchObject({ conversationId: 'c-1' });
    const waitTask = fake.tasks.find((task) => task.op === 'turns.waitReply');
    expect(fake.aborts).toEqual([{ taskId: waitTask?.taskId, reason: 'cancelled' }]);
    // Nothing was dispatched after the abort.
    expect(fake.tasks.at(-1)?.op).toBe('turns.waitReply');
    release();

    expect((await t.cli('POST', bridgePath.jobCancel(jobId))).status).toBe(410);
    fake.handlers['turns.waitReply'] = ASK_HANDLERS['turns.waitReply'];
    const next = await submitAsk(t, 'again');
    expect(next.status).toBe(202);
    expect((await finished(t, data<JobSubmitResponse>(next).jobId)).status).toBe('succeeded');
  });

  it('stays cancelling and busy until the extension lets go of the cancelled task', async () => {
    const { t, fake } = await setup({ pollHoldMs: 300, abortResendMs: 50 });
    fake.handlers['turns.waitReply'] = () => new Promise(() => {});
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    await until(() => fake.tasks.some((task) => task.op === 'turns.waitReply'));
    const waitTask = fake.tasks.find((task) => task.op === 'turns.waitReply');
    if (waitTask === undefined) throw new Error('unreachable');
    // The browser goes quiet with the task still running on the page.
    await fake.stop();
    await t.cli('POST', bridgePath.jobCancel(jobId));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(data<JobDetail>(await t.cli('GET', bridgePath.job(jobId))).status).toBe('cancelling');
    expect(errorCode(await submitAsk(t, 'meanwhile'))).toBe('busy');

    const listed = [{ taskId: waitTask.taskId, state: 'running' as const }];
    expect((await fake.poll(listed)).message).toEqual({
      kind: 'abort',
      taskId: waitTask.taskId,
      reason: 'cancelled',
    });
    expect((await fake.poll([])).status).toBe(204);
    expect((await finished(t, jobId)).status).toBe('cancelled');
    expect((await submitAsk(t, 'after')).status).toBe(202);
  });

  it('frees the slot when the extension disappears mid-task', async () => {
    const { t, fake } = await setup({ extensionOfflineMs: 400, pollHoldMs: 100 });
    fake.handlers['composer.send'] = () => new Promise(() => {});
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    await until(() => fake.tasks.some((task) => task.op === 'composer.send'));
    await fake.stop();
    const job = await finished(t, jobId);
    expect(job.status).toBe('needs-user');
    expect(job.error?.code).toBe('extension-offline');
    expect(exitForJob(job)).toBe(7);
    expect((await submitAsk(t)).status).toBe(202);
  });

  it('marks a job that was running when serve stopped as detached, without resuming it', async () => {
    const first = (await setup()).t;
    const jobDir = join(first.paths.jobs, 'jold1');
    await mkdir(jobDir, { recursive: true });
    await writeJsonAtomic(join(jobDir, 'job.json'), {
      jobId: 'jold1',
      plugin: 'ask',
      command: 'ask',
      input: { prompt: 'x' },
      status: 'waiting-reply',
      createdAt: 1,
      updatedAt: 1,
      checkpoints: { sent: { conversationId: 'c-9', userTurnKey: 't-9' } },
    });
    const restarted = await first.restart();
    t = restarted;
    const job = data<JobDetail>(await restarted.cli('GET', bridgePath.job('jold1')));
    expect(job.status).toBe('detached');
    expect(job.checkpoints.sent).toMatchObject({ conversationId: 'c-9' });
    const status = data<{ activeJob?: unknown }>(await restarted.cli('GET', BRIDGE_PATHS.status));
    expect(status.activeJob).toBeUndefined();
    const restartedEvents = await events(restarted, 'jold1');
    expect(restartedEvents.at(-1)).toMatchObject({ type: 'done', data: { status: 'detached' } });
  });
});
