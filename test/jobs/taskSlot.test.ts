import { OP_NAMES, type OpName, type PollResponse } from '@voyager-crew/bridge-protocol';
import { describe, expect, it } from 'vitest';

import { TaskSlot, type PollView } from '../../src/jobs/taskSlot';
import { BridgeFailure } from '../../src/util/errors';

const ALL_OPS: ReadonlySet<OpName> = new Set(OP_NAMES);
const view = (inflight: string[] = [], overrides: Partial<PollView> = {}): PollView => ({
  inflight: new Set(inflight),
  ops: ALL_OPS,
  policy: 'allowed',
  ...overrides,
});
const sendParams = { text: 'hi' };
const sendResult = { conversationId: 'c-1', url: 'https://chatgpt.com/c/c-1', userTurnKey: 't-1' };

function taskOf(response: PollResponse | undefined) {
  if (response?.kind !== 'task')
    throw new Error(`expected a task, got ${JSON.stringify(response)}`);
  return response.task;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeFailure) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

function queue(slot: TaskSlot, options: { signal?: AbortSignal; deadlineMs?: number } = {}) {
  const promise = slot.run({
    jobId: 'j1',
    op: 'composer.send',
    params: sendParams,
    deadlineMs: options.deadlineMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  promise.catch(() => undefined);
  return promise;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('task delivery', () => {
  it('delivers an unacked task again, with the same taskId, when the poll does not list it', async () => {
    const slot = new TaskSlot();
    void queue(slot);
    await tick();
    const first = taskOf(slot.poll(view()));
    const again = taskOf(slot.poll(view()));
    expect(again.taskId).toBe(first.taskId);
    expect(again.issuedAt).toBe(first.issuedAt);
    slot.close();
  });

  it('never delivers an acked task twice: a poll without it fails it as extension-reloaded', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    expect(slot.ack(task.taskId).kind).toBe('ok');
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    expect(slot.poll(view([]))).toBeUndefined();
    expect(await rejection(result)).toBe('extension-reloaded');
    expect(slot.current()).toBeUndefined();
    expect(slot.poll(view([]))).toBeUndefined();
    expect(slot.ack(task.taskId).kind).toBe('gone');
  });

  it('counts only the first result and validates it against the op', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('ok');
    expect(await result).toEqual(sendResult);
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('duplicate');

    const invalid = queue(slot);
    await tick();
    const second = taskOf(slot.poll(view()));
    const reply = slot.result(second.taskId, { ok: true, data: { conversationId: '../x' } });
    expect(reply.kind).toBe('invalid');
    expect(await rejection(invalid)).toBe('bad-request');
  });

  it('passes the extension error through with its category', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.result(task.taskId, {
      ok: false,
      error: { code: 'challenge', category: 'user-action', message: 'Cloudflare' },
    });
    expect(await rejection(result)).toBe('challenge');
  });

  it('drops repeated progress by seq', async () => {
    const slot = new TaskSlot();
    const seen: unknown[] = [];
    const result = slot.run({
      jobId: 'j1',
      op: 'composer.send',
      params: sendParams,
      deadlineMs: 30_000,
      onProgress: (event) => seen.push(event),
    });
    await tick();
    const task = taskOf(slot.poll(view()));
    expect(slot.progress(task.taskId, 1, { n: 1 }).kind).toBe('ok');
    expect(slot.progress(task.taskId, 1, { n: 1 }).kind).toBe('duplicate');
    expect(slot.progress(task.taskId, 2, { n: 2 }).kind).toBe('ok');
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    slot.result(task.taskId, { ok: true, data: sendResult });
    await result;
  });
});

describe('abandoning a task', () => {
  it('frees the slot at once when the task was never delivered', async () => {
    const slot = new TaskSlot();
    const controller = new AbortController();
    const result = queue(slot, { signal: controller.signal });
    await tick();
    controller.abort();
    expect(await rejection(result)).toBe('cancelled');
    expect(slot.current()).toBeUndefined();
    expect(slot.poll(view())).toBeUndefined();
  });

  it('holds the slot after a cancel until the extension lets go of the task', async () => {
    const slot = new TaskSlot();
    const controller = new AbortController();
    const result = queue(slot, { signal: controller.signal });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    controller.abort();
    expect(await rejection(result)).toBe('cancelled');

    let idle = false;
    void slot.idle().then(() => {
      idle = true;
    });
    expect(slot.poll(view([task.taskId]))).toEqual({
      kind: 'abort',
      taskId: task.taskId,
      reason: 'cancelled',
    });
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    await tick();
    expect(idle).toBe(false);
    // The next job's op waits behind it.
    const next = queue(slot);
    expect(slot.poll(view([]))).toBeUndefined();
    await tick();
    expect(idle).toBe(true);
    expect(taskOf(slot.poll(view([]))).taskId).not.toBe(task.taskId);
    slot.close();
    await next.catch(() => undefined);
  });

  it('sends the abort again when the extension still lists the task (the first went to a dropped poll)', async () => {
    const slot = new TaskSlot({ abortResendMs: 30 });
    const controller = new AbortController();
    void queue(slot, { signal: controller.signal });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    controller.abort();
    expect(slot.poll(view([task.taskId]))?.kind).toBe('abort');
    expect(slot.poll(view([task.taskId]))).toBeUndefined();
    let woken = false;
    const unsubscribe = slot.onChange(() => {
      woken = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    unsubscribe();
    expect(woken).toBe(true);
    expect(slot.poll(view([task.taskId]))).toMatchObject({ kind: 'abort', taskId: task.taskId });
    expect(slot.poll(view([]))).toBeUndefined();
    expect(slot.current()).toBeUndefined();
  });

  it('aborts with timeout when the result does not come within the deadline', async () => {
    const slot = new TaskSlot({ deadlineGraceMs: 0 });
    const result = queue(slot, { deadlineMs: 30 });
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(await rejection(result)).toBe('timeout');
    expect(slot.poll(view([task.taskId]))).toMatchObject({ kind: 'abort', reason: 'timeout' });
    expect(slot.result(task.taskId, { ok: true, data: sendResult }).kind).toBe('gone');
    expect(slot.current()).toBeUndefined();
  });

  it('fails the task and frees the slot when the extension stops polling', async () => {
    const slot = new TaskSlot({ extensionOfflineMs: 50 });
    const result = queue(slot);
    await tick();
    const task = taskOf(slot.poll(view()));
    slot.ack(task.taskId);
    expect(await rejection(result)).toBe('extension-offline');
    expect(slot.current()).toBeUndefined();
  });
});

describe('what the extension offers', () => {
  it('refuses an op the extension did not declare', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { ops: new Set<OpName>(['turns.read']) }))).toBeUndefined();
    expect(await rejection(result)).toBe('unsupported-op');
  });

  it('refuses to dispatch while the policy denies the bridge', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { policy: 'denied' }))).toBeUndefined();
    expect(await rejection(result)).toBe('policy-denied');
  });

  it('says the policy is stale, not that the op is unsupported, when the extension offers no ops', async () => {
    const slot = new TaskSlot();
    const result = queue(slot);
    await tick();
    expect(slot.poll(view([], { policy: 'stale', ops: new Set() }))).toBeUndefined();
    expect(await rejection(result)).toBe('policy-stale');
  });
});
