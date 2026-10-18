/**
 * A ChatGPT conversation as a person names it: a link (`/c/<id>`, a GPT's or a
 * project's `/g/<gizmo>/c/<id>`) or the bare id. Anything else is refused here,
 * before a tab opens.
 */
import { validateOpParams } from '@voyager-crew/bridge-protocol';

import { failure } from './errors';

const HOSTS: ReadonlySet<string> = new Set(['chatgpt.com', 'chat.openai.com']);
// The shape of `conversationIdPattern` in the extension's chatgpt site.json.
const CONVERSATION_PATH = /^(?:\/u\/[^/]+)?(?:\/g\/[^/]+)?\/c\/([^/]+)\/?$/;
// ChatGPT's conversation ids are UUIDs; a bare word is far more likely a slip than an id.
const BARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usable(id: string): boolean {
  // A new chat's provisional `local-…` id never names a stored conversation.
  if (id.startsWith('local-')) return false;
  return validateOpParams('conversation.open', { conversationId: id }).ok;
}

function fromUrl(raw: string): string | undefined {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '' || !HOSTS.has(url.hostname)) return undefined;
  const match = CONVERSATION_PATH.exec(url.pathname);
  if (!match) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return usable(id) ? id : undefined;
}

/** The conversation id `raw` names, or a `bad-request` failure that says what is accepted. */
export function parseConversationRef(raw: string): string {
  const text = raw.trim();
  if (BARE_ID.test(text)) return text.toLowerCase();
  const id = text.includes('/') ? fromUrl(text) : undefined;
  if (id !== undefined) return id;
  throw failure(
    'bad-request',
    `not a ChatGPT conversation: ${JSON.stringify(raw)}. Give a link like https://chatgpt.com/c/<id> (or /g/<gpt>/c/<id>), or the conversation id`,
  );
}
