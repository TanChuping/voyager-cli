/**
 * Extension endpoints (spec §2.2): bearer ext-token and the paired Origin.
 * Uploads are read with `POST /v1/ext/blobs/:id/read` (a POST, so the
 * service worker's request always carries its Origin); downloads arrive with
 * `files.download`.
 */
import {
  BRIDGE_PATHS,
  validateMessage,
  type BlobChunk,
  type PollResponse,
} from '@voyager-crew/bridge-protocol';

import type { TaskReply } from '../../jobs/taskSlot';
import { failure } from '../../util/errors';
import { bearer } from '../guards';
import type { Reply, Route, RouteContext, ServerCore } from '../http';
import { forbidden, HttpFailure } from '../respond';

const TASK = '([A-Za-z0-9_-]{1,128})';

/** Returns 'revoked' for a token that was replaced or revoked, so poll can say `unpaired`. */
function authorize(core: ServerCore, ctx: RouteContext): 'ok' | 'revoked' {
  const check = core.pairing.checkToken(bearer(ctx.req), ctx.origin);
  if (check === 'ok' || check === 'revoked') return check;
  if (check === 'bad-origin') throw forbidden('Origin is not the paired extension');
  throw failure('unauthorized', 'missing or wrong extension token');
}

function requirePaired(core: ServerCore, ctx: RouteContext): void {
  if (authorize(core, ctx) === 'revoked') throw failure('unauthorized', 'this pairing was revoked');
}

function taskReply(reply: TaskReply): Reply {
  switch (reply.kind) {
    case 'ok':
      return { status: 200, data: { accepted: true } };
    case 'duplicate':
      return { status: 200, data: { accepted: false } };
    case 'gone':
      throw failure('gone', 'the task has already ended');
    case 'not-found':
      throw failure('not-found', 'no such task');
    case 'invalid':
      throw new HttpFailure(
        400,
        failure('bad-request', 'invalid op result', { issues: reply.issues }).error,
      );
  }
}

/**
 * One chunk of an upload, as base64. Served only while the blob's own job
 * runs `composer.attach`, so a paired extension cannot read a job's files
 * at any other time.
 */
async function readBlob(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  requirePaired(core, ctx);
  const checked = validateMessage('blobChunkRange', ctx.body);
  if (!checked.ok) throw failure('bad-request', 'invalid chunk range', { issues: checked.issues });
  const blob = core.blobs.get(ctx.params[0]);
  if (blob === undefined) throw failure('not-found', 'no such blob');
  const task = core.slot.current();
  if (task === undefined || task.jobId !== blob.jobId || task.op !== 'composer.attach') {
    throw failure('gone', 'no upload of this blob is running');
  }
  const { offset, length } = checked.value;
  if (offset + length > blob.size) throw failure('bad-request', 'the range lies outside the blob');
  const bytes = await core.blobs.read(blob, offset, length);
  const chunk: BlobChunk = { blobId: blob.blobId, offset, base64: bytes.toString('base64') };
  return { status: 200, data: chunk };
}

async function poll(core: ServerCore, ctx: RouteContext): Promise<Reply> {
  if (authorize(core, ctx) === 'revoked') {
    const unpaired: PollResponse = { kind: 'unpaired' };
    return { status: 200, data: unpaired };
  }
  const checked = validateMessage('pollRequest', ctx.body);
  if (!checked.ok) throw failure('bad-request', 'invalid poll', { issues: checked.issues });
  const request = checked.value;
  core.extension.lastPollAt = core.now();
  core.extension.ops = request.capabilities.ops;
  core.extension.policy = request.policy;
  core.slot.notePoll();
  // A newer poll replaces a held one (the service worker restarted, or retried).
  core.heldPoll?.();

  const view = {
    inflight: new Set(request.inflight.map((entry) => entry.taskId)),
    ops: core.extension.opNames(),
    policy: request.policy.state,
  };
  const immediate = core.slot.poll(view);
  if (immediate !== undefined) return { status: 200, data: immediate };

  const held = await new Promise<PollResponse | undefined>((resolve) => {
    let finished = false;
    const finish = (response: PollResponse | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      if (core.heldPoll === end) core.heldPoll = undefined;
      resolve(response);
    };
    const end = (): void => finish(undefined);
    const timer = setTimeout(end, core.pollHoldMs);
    const unsubscribe = core.slot.onChange(() => {
      if (finished || ctx.res.destroyed) return;
      const response = core.slot.poll(view);
      if (response !== undefined) finish(response);
    });
    // A poll whose connection dropped must not take a task with it.
    ctx.res.once('close', end);
    core.heldPoll = end;
  });
  return held === undefined ? { status: 204 } : { status: 200, data: held };
}

export function extRoutes(core: ServerCore): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/v1\/ext\/poll$/,
      access: 'ext',
      handle: (ctx) => poll(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/ack$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        return taskReply(core.slot.ack(ctx.params[0]));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/progress$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        const checked = validateMessage('taskProgress', ctx.body);
        if (!checked.ok)
          throw failure('bad-request', 'invalid progress', { issues: checked.issues });
        return taskReply(core.slot.progress(ctx.params[0], checked.value.seq, checked.value.event));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/tasks/${TASK}/result$`),
      access: 'ext',
      handle: (ctx) => {
        requirePaired(core, ctx);
        const checked = validateMessage('taskResult', ctx.body);
        if (!checked.ok) throw failure('bad-request', 'invalid result', { issues: checked.issues });
        return taskReply(core.slot.result(ctx.params[0], checked.value));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/ext/blobs/${TASK}/read$`),
      access: 'ext',
      handle: (ctx) => readBlob(core, ctx),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^${BRIDGE_PATHS.extUnpair.replace(/\//g, '\\/')}$`),
      access: 'ext',
      handle: async (ctx) => {
        requirePaired(core, ctx);
        await core.pairing.revoke();
        core.extension.forget();
        core.log.info('extension unpaired itself');
        return { status: 200, data: { revoked: true } };
      },
    },
  ];
}
