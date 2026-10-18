import {
  BRIDGE_PATHS,
  bridgePath,
  type JobEventsResponse,
  type JobSubmitResponse,
} from '@voyager-crew/bridge-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { JobDetail } from '../../src/jobs/jobStore';
import { FakeExtension, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, type TestServer } from '../helpers/server';

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function paired(pollHoldMs: number) {
  t = await startTestServer({ pollHoldMs });
  const fake = new FakeExtension(t.port);
  await pairFake(fake, t.cli);
  return { t, fake };
}

describe('extension long poll', () => {
  it('answers 204 when the hold ends with nothing to deliver', async () => {
    const { fake } = await paired(200);
    const started = Date.now();
    expect((await fake.poll()).status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('wakes a held poll as soon as a task is queued', async () => {
    const { t, fake } = await paired(5_000);
    const started = Date.now();
    const polled = fake.poll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.cli('POST', BRIDGE_PATHS.call, { op: 'model.inspect', params: {} });
    const { message } = await polled;
    expect(message).toMatchObject({ kind: 'task', task: { op: 'model.inspect' } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fake.protocolErrors).toEqual([]);
  });

  it('ends a held poll when a newer one arrives, so only one connection can take a task', async () => {
    const { fake } = await paired(5_000);
    const started = Date.now();
    const older = fake.poll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newer = fake.poll();
    expect((await older).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(2_000);
    void newer.catch(() => undefined);
    await fake.stop();
  });

  it('gives a task to the newly paired extension, never to the poll the replaced pairing held', async () => {
    const { t, fake: replaced } = await paired(5_000);
    const started = Date.now();
    const older = replaced.poll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = new FakeExtension(t.port);
    await pairFake(current, t.cli);
    await t.cli('POST', BRIDGE_PATHS.call, { op: 'composer.send', params: { text: 'secret' } });

    const held = await older;
    expect(held.message?.kind).not.toBe('task');
    expect(Date.now() - started).toBeLessThan(2_000);
    // Polling again with the replaced token is told it is no longer paired.
    expect((await replaced.poll()).message).toEqual({ kind: 'unpaired' });
    const { message } = await current.poll();
    expect(message).toMatchObject({ kind: 'task', task: { op: 'composer.send' } });
  });
});

describe('job events long poll', () => {
  it('returns no events when the wait ends, and the job keeps running', async () => {
    const { t } = await paired(5_000);
    const { jobId } = data<JobSubmitResponse>(
      await t.cli('POST', BRIDGE_PATHS.jobs, {
        plugin: 'ask',
        command: 'ask',
        input: { prompt: 'x', keepTab: false },
      }),
    );
    const { events: initial } = data<JobEventsResponse>(
      await t.cli('GET', `${bridgePath.jobEvents(jobId)}?after=0`),
    );
    const last = initial.at(-1)?.seq ?? 0;
    const started = Date.now();
    const { events } = data<JobEventsResponse>(
      await t.cli('GET', `${bridgePath.jobEvents(jobId)}?after=${last}&wait=1`),
    );
    expect(events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const job = data<JobDetail>(await t.cli('GET', bridgePath.job(jobId)));
    expect(job.status).toBe('running');
    expect(
      data<{ activeJob?: { jobId: string } }>(await t.cli('GET', BRIDGE_PATHS.status)).activeJob
        ?.jobId,
    ).toBe(jobId);
  });
});
