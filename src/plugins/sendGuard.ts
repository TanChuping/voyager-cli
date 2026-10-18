/**
 * `composer.send` once, recorded so that nothing reads an unconfirmed send as
 * "not sent". The request carrying the prompt leaves the browser right after
 * the click, while the settled conversation id that confirms it can take tens
 * of seconds more: a deadline, a lost extension or tab, a cancel or a serve
 * restart in that window must never invite a resend.
 */
import {
  bridgeError,
  type BridgeError,
  type ComposerSendParams,
  type ComposerSendResult,
  type ErrorCode,
} from '@voyager-crew/bridge-protocol';

import { BridgeFailure, toBridgeError } from '../util/errors';
import type { JobContext } from './api';

/** Written and flushed right before `composer.send` is dispatched; `sent` follows on success. */
const SENDING_CHECKPOINT = 'sending';

/**
 * Codes the extension raises only before it clicks Send (composerSend.ts `ctx.fail`
 * ahead of the click); after the click every failure there is `send-unverified`.
 * Anything else may come from after the click, so it counts as possibly sent.
 */
const BEFORE_CLICK: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'composer-busy',
  'selector-missing',
  'attachment-rejected',
  'mode-unavailable',
  'mode-unknown',
]);

/** True only when the error proves the prompt never went out. */
function failedBeforeClick(error: BridgeError): boolean {
  if (BEFORE_CLICK.has(error.code)) return true;
  if (error.code !== 'unverified') return false;
  // `unverified` also comes from the dispatcher after a send; only these two are pre-click.
  const { stage, reason } = error.details ?? {};
  return stage === 'fill' || reason === 'conversation-mismatch';
}

export function sendUnverified(
  message: string,
  details: Readonly<Record<string, unknown>>,
): BridgeError {
  return bridgeError('send-unverified', message, { ...details, sent: 'unknown' });
}

/** Whether a job's checkpoints show a send that was dispatched but never confirmed. */
export function sendInterrupted(checkpoints: Readonly<Record<string, unknown>>): boolean {
  return checkpoints[SENDING_CHECKPOINT] !== undefined && checkpoints.sent === undefined;
}

/** `composer.send`, with every outcome but success or a proven pre-click failure as `send-unverified`. */
export async function sendOnce(
  ctx: JobContext,
  params: ComposerSendParams,
): Promise<ComposerSendResult> {
  // Kept free of `conversationId`: that key in a checkpoint marks a sent prompt.
  await ctx.checkpoint(SENDING_CHECKPOINT, { at: Date.now() });
  try {
    return await ctx.ops.call('composer.send', params);
  } catch (thrown) {
    const error = toBridgeError(thrown);
    if (error.code === 'send-unverified' || failedBeforeClick(error)) throw thrown;
    throw new BridgeFailure(
      sendUnverified(
        `composer.send ended with ${error.code} after it was dispatched (${error.message}); the prompt may have been sent`,
        { ...error.details, cause: error.code },
      ),
    );
  }
}
