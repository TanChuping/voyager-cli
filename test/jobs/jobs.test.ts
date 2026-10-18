import {
  BRIDGE_PATHS,
  bridgePath,
  type JobEventsResponse,
  type JobSubmitResponse,
  WAIT_REPLY_MAX_TIMEOUT_MS,
} from '@voyager-crew/bridge-protocol';
import { chmod, mkdir, readFile } from 'node:fs/promises';
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

  it('tells the caller a stale policy needs the person, not that the ops are unsupported', async () => {
    const { t, fake } = await setup();
    fake.policy = { revision: 7, state: 'stale' };
    fake.ops = [];
    await fake.poll();

    const ask = await submitAsk(t);
    expect(ask.status).toBe(412);
    expect(errorCode(ask)).toBe('policy-stale');
    const call = await t.cli('POST', BRIDGE_PATHS.call, {
      op: 'turns.read',
      params: { conversationId: 'c-1', assistantTurnKey: 't-2' },
    });
    expect(call.status).toBe(412);
    expect(errorCode(call)).toBe('policy-stale');

    fake.policy = { revision: 8, state: 'denied' };
    await fake.poll();
    expect(errorCode(await submitAsk(t))).toBe('policy-denied');
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
      'model.select',
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

  it('gives the reply wait the longest budget the bridge allows, enough for a reply of many hours', async () => {
    const { t, fake } = await setup();
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    expect((await finished(t, jobId)).status).toBe('succeeded');
    const waitTask = fake.tasks.find((task) => task.op === 'turns.waitReply');
    expect(waitTask?.params).not.toHaveProperty('timeoutMs');
    expect(waitTask?.deadlineMs).toBeGreaterThanOrEqual(WAIT_REPLY_MAX_TIMEOUT_MS);
    expect(WAIT_REPLY_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(12 * 3_600_000);
  });

  it('is detached, and sends nothing again, when the reply stalls after the send', async () => {
    const { t, fake } = await setup();
    fake.handlers['turns.waitReply'] = () => {
      throw new OpError('reply-stalled');
    };
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    const job = await finished(t, jobId);
    expect(job.status).toBe('detached');
    expect(job.error?.code).toBe('reply-stalled');
    expect(exitForJob(job)).toBe(6);
    expect(fake.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
  });

  it('fails without waiting for the reply when the sent checkpoint cannot be written, and sends once', async () => {
    const { t, fake } = await setup();
    let jobDir: string | undefined;
    fake.handlers['composer.send'] = async (params, task) => {
      jobDir = join(t.paths.jobs, task.jobId);
      // The job's folder turns read-only (a full or locked disk) once the prompt went out.
      await chmod(jobDir, 0o500);
      return ASK_HANDLERS['composer.send']?.(params, task, {
        progress: async () => {},
        aborted: () => false,
      });
    };
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    try {
      const job = await finished(t, jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'bad-request', details: { checkpoint: 'sent' } });
      expect(fake.tasks.map((task) => task.op)).toEqual([
        'conversation.open',
        'model.select',
        'composer.send',
      ]);
    } finally {
      if (jobDir !== undefined) await chmod(jobDir, 0o700);
    }
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

  it('reports a lost extension after the send click as possibly sent, and frees the slot', async () => {
    const { t, fake } = await setup({ extensionOfflineMs: 400, pollHoldMs: 100 });
    fake.handlers['composer.send'] = () => new Promise(() => {});
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    await until(() => fake.tasks.some((task) => task.op === 'composer.send'));
    await fake.stop();
    const job = await finished(t, jobId);
    expectPossiblySent(job, fake);
    expect(job.error?.details).toMatchObject({ cause: 'extension-offline' });
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

/** The job a send that went out unconfirmed must end as: never an invitation to resend. */
function expectPossiblySent(job: JobDetail, ext: FakeExtension): void {
  expect(job.status).toBe('failed');
  expect(job.error).toMatchObject({ code: 'send-unverified', details: { sent: 'unknown' } });
  expect(exitForJob(job)).toBe(2);
  expect(job.checkpoints.sending).toBeDefined();
  expect(job.checkpoints.sent).toBeUndefined();
  expect(ext.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
  expect(ext.tasks.map((task) => task.op)).not.toContain('turns.waitReply');
}

describe('a send that may have gone out', () => {
  it('a late send confirmation never invites a resend: the CLI deadline runs out first', async () => {
    // The CLI gives up on composer.send 1 s after dispatch instead of 35 s.
    const { t, fake } = await setup({ deadlineGraceMs: -29_000, pollHoldMs: 100 });
    fake.handlers['composer.send'] = () => new Promise(() => {});
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    const job = await finished(t, jobId);
    expectPossiblySent(job, fake);
    expect(job.error?.details).toMatchObject({ cause: 'timeout' });
  });

  it.each(['timeout', 'document-lost', 'tab-closed', 'extension-reloaded', 'cancelled'] as const)(
    'a send that ends in %s after the click is reported as possibly sent',
    async (code) => {
      const { t, fake } = await setup();
      fake.handlers['composer.send'] = () => {
        throw new OpError(code);
      };
      fake.start();
      const job = await finished(t, data<JobSubmitResponse>(await submitAsk(t)).jobId);
      expectPossiblySent(job, fake);
      expect(job.error?.details).toMatchObject({ cause: code });
    },
  );

  it('a page result that does not match the protocol is reported as possibly sent', async () => {
    const { t, fake } = await setup();
    // The dispatcher's `unverified` for a malformed page result carries no pre-click stage.
    fake.handlers['composer.send'] = () => {
      throw new OpError('unverified', 'The page returned a malformed result.');
    };
    fake.start();
    const job = await finished(t, data<JobSubmitResponse>(await submitAsk(t)).jobId);
    expectPossiblySent(job, fake);
  });

  it('a cancel while the send is unconfirmed is reported as possibly sent, not cancelled', async () => {
    const { t, fake } = await setup({ pollHoldMs: 100 });
    fake.handlers['composer.send'] = () => new Promise(() => {});
    fake.start();
    const { jobId } = data<JobSubmitResponse>(await submitAsk(t));
    await until(() => fake.tasks.some((task) => task.op === 'composer.send'));
    await t.cli('POST', bridgePath.jobCancel(jobId));
    const job = await finished(t, jobId);
    expectPossiblySent(job, fake);
    expect((await submitAsk(t, 'after')).status).toBe(202);
  });

  it.each([
    ['composer-busy', undefined],
    ['selector-missing', undefined],
    ['unverified', { stage: 'fill' }],
    ['unverified', { reason: 'conversation-mismatch' }],
  ] as const)(
    'a send refused before the click (%s %j) keeps its own error',
    async (code, details) => {
      const { t, fake } = await setup();
      fake.handlers['composer.send'] = () => {
        throw new OpError(code, code, details);
      };
      fake.start();
      const job = await finished(t, data<JobSubmitResponse>(await submitAsk(t)).jobId);
      expect(job.error?.code).toBe(code);
      expect(fake.tasks.filter((task) => task.op === 'composer.send')).toHaveLength(1);
    },
  );

  it('a serve restart between the send and its confirmation is reported as possibly sent, not detached', async () => {
    const first = (await setup()).t;
    const jobDir = join(first.paths.jobs, 'jsend1');
    await mkdir(jobDir, { recursive: true });
    await writeJsonAtomic(join(jobDir, 'job.json'), {
      jobId: 'jsend1',
      plugin: 'ask',
      command: 'ask',
      input: { prompt: 'x' },
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      checkpoints: { opened: { tabId: 7 }, sending: { at: 1 } },
    });
    const restarted = await first.restart();
    t = restarted;
    const job = data<JobDetail>(await restarted.cli('GET', bridgePath.job('jsend1')));
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'send-unverified' });
    expect(exitForJob(job)).toBe(2);
    expect((await events(restarted, 'jsend1')).at(-1)).toMatchObject({
      type: 'done',
      data: { status: 'failed', error: { code: 'send-unverified' } },
    });
  });
});
