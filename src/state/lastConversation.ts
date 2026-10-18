/**
 * The conversation of the last job that succeeded (`last-conversation.json`,
 * 0600), for `voyager ask --continue`. Serve writes it when such a job ends,
 * so a `--no-wait` run counts too; the foreground only reads it.
 */
import { validateOpParams } from '@voyager-crew/bridge-protocol';

import { readJsonFile, writeJsonAtomic } from '../util/files';
import { isRecord } from '../util/isRecord';
import type { StatePaths } from './paths';

export interface LastConversation {
  readonly conversationId: string;
  readonly url?: string;
  readonly jobId: string;
  readonly command: string;
  readonly at: number;
}

export async function recordLastConversation(
  paths: StatePaths,
  entry: LastConversation,
): Promise<void> {
  await writeJsonAtomic(paths.lastConversation, entry);
}

/** The recorded conversation, or undefined when there is none or the file is unreadable. */
export async function readLastConversation(
  paths: StatePaths,
): Promise<LastConversation | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonFile(paths.lastConversation);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.conversationId !== 'string') return undefined;
  if (!validateOpParams('conversation.open', { conversationId: raw.conversationId }).ok) {
    return undefined;
  }
  return {
    conversationId: raw.conversationId,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    jobId: typeof raw.jobId === 'string' ? raw.jobId : '',
    command: typeof raw.command === 'string' ? raw.command : '',
    at: typeof raw.at === 'number' ? raw.at : 0,
  };
}
