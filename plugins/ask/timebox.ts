/**
 * `ask --timebox <minutes>`: ask ChatGPT to keep its own clock. A Pro turn
 * that runs long sandbox work can lose its connection after about 80 minutes
 * ("connection interrupted, waiting for the full response"); from then on it
 * delivers nothing, and what it made in its sandbox is gone. With a countdown
 * shorter than that, it wraps up and hands over what it has, finished and
 * half-done work kept apart, before the turn can break.
 *
 * Only words in the prompt: nothing here watches the clock. Field practice
 * with 70 minutes: a dozen long turns delivered in 62–80 minutes, none broke.
 */
import { failure } from '../../src/util/errors';

export const SUGGESTED_TIMEBOX_MINUTES = 70;
const MIN_MINUTES = 5;
const MAX_MINUTES = 600;

export function parseTimebox(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim().replace(/m$/i, '');
  const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(minutes >= MIN_MINUTES && minutes <= MAX_MINUTES)) {
    throw failure(
      'bad-request',
      `--timebox takes minutes from ${MIN_MINUTES} to ${MAX_MINUTES} (${SUGGESTED_TIMEBOX_MINUTES} for long Pro work), not ${JSON.stringify(String(raw))}`,
    );
  }
  return minutes;
}

/**
 * Purpose and judgment rather than orders: Pro takes "must" literally and
 * turns defensive, so the block says why the clock matters and lets it weigh.
 */
export function timeboxPromptBlock(minutes: number): string {
  return [
    `Time and wrap-up: a turn like this can lose its connection after about 80 minutes of work, and after that nothing is delivered and the sandbox files are lost. So please plan around a ${minutes}-minute countdown:`,
    `- When you start, note the time in your sandbox, and check it after each piece of work.`,
    `- When the ${minutes} minutes are up, start nothing new, wherever you are, and wrap up; leave about 10 minutes for that.`,
    `- Finish one piece completely before starting the next, so that a stop leaves whole pieces rather than many halves. If something still fails on the third try, set it aside, note it, and move on.`,
    `- If you make files, put them under /mnt/data/ and link them in your reply. Link each finished piece as soon as it is done, then one ZIP at the end with finished/ (work that passed your checks), unfinished/ (each with how far it got and what is missing) and METHOD.md (how you worked, how you checked, what did not work).`,
    `- If you use subagents, they keep the same countdown and hand back what they have before it ends.`,
    `- Open your reply with one line: finished N / unfinished M / about X minutes.`,
  ].join('\n');
}
