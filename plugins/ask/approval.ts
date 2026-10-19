/**
 * ChatGPT's app approval card ("Allow ChatGPT to use Google Drive?") stops a
 * reply until someone answers it, and "Always allow" does not keep it away for
 * good (docs/notes/2026-10-20-approval-card). Without `--approve-apps` the job
 * ends on it with `approval-required` (exit 3) instead of waiting for a click
 * nobody makes; with it, the page clicks that answer and the wait goes on.
 */
import { type ApprovalChoice, type TurnsWaitReplyResult } from '@voyager-crew/bridge-protocol';

import type { JobContext } from '../../src/plugins/api';
import { failure, toBridgeError } from '../../src/util/errors';

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['always', 'once'];

/** Cards one reply may answer: each tool call can ask, and a page that keeps asking must not loop. */
const MAX_APPROVALS = 10;

export function parseApproveApps(raw: unknown): ApprovalChoice | undefined {
  if (raw === undefined) return undefined;
  const choice = APPROVAL_CHOICES.find((known) => known === raw);
  if (choice === undefined) {
    throw failure('bad-request', `--approve-apps takes ${APPROVAL_CHOICES.join(' or ')}`);
  }
  return choice;
}

interface ReplyTarget {
  readonly conversationId: string;
  readonly afterUserTurnKey: string;
  /** The conversation's link, where the person can answer the card. */
  readonly url: string;
}

/** `turns.waitReply`, answering each approval card with `choice` when one is given. */
export async function waitReplyApproving(
  ctx: JobContext,
  target: ReplyTarget,
  choice: ApprovalChoice | undefined,
): Promise<TurnsWaitReplyResult> {
  const params = {
    conversationId: target.conversationId,
    afterUserTurnKey: target.afterUserTurnKey,
    stopOnApproval: true,
  };
  for (let answered = 0; ; answered += 1) {
    try {
      return await ctx.ops.call('turns.waitReply', params);
    } catch (thrown) {
      const error = toBridgeError(thrown);
      if (error.code !== 'approval-required') throw thrown;
      const app =
        typeof error.details?.app === 'string' && error.details.app !== ''
          ? error.details.app
          : 'one of its apps';
      if (choice === undefined) {
        throw failure(
          'approval-required',
          `ChatGPT asks to allow ${app} before the reply goes on: answer it at ${target.url} and read the reply with \`voyager read\`, or ask with --approve-apps always`,
          error.details,
        );
      }
      if (answered >= MAX_APPROVALS) {
        throw failure(
          'approval-required',
          `ChatGPT asked to allow ${app} again after ${MAX_APPROVALS} answers`,
          error.details,
        );
      }
      const approved = await ctx.ops.call('turns.approve', {
        conversationId: target.conversationId,
        afterUserTurnKey: target.afterUserTurnKey,
        choice,
      });
      ctx.log.info('answered an app approval card', {
        app: approved.app,
        choice,
        clicked: approved.clicked,
      });
    }
  }
}
