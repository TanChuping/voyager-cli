import { describe, expect, it } from 'vitest';

import { parseConversationRef } from '../../src/util/conversationRef';
import { BridgeFailure } from '../../src/util/errors';

const ID = '6ad3f5e3-4464-83ed-8167-4abe151af1ff';

function codeOf(raw: string): string | undefined {
  try {
    parseConversationRef(raw);
  } catch (error) {
    return error instanceof BridgeFailure ? error.code : String(error);
  }
  return undefined;
}

describe('parseConversationRef', () => {
  it.each([
    [`https://chatgpt.com/c/${ID}`],
    [`https://chatgpt.com/c/${ID}/`],
    [`https://chatgpt.com/c/${ID}?model=gpt-6#top`],
    [`https://chatgpt.com/g/g-abc123-code-helper/c/${ID}`],
    [`https://chatgpt.com/g/g-p-68f1c2a01b2c-thesis/c/${ID}`],
    [`https://chat.openai.com/c/${ID}`],
    [`chatgpt.com/c/${ID}`],
    [ID],
    [`  ${ID.toUpperCase()}  `],
  ])('reads the conversation id from %s', (raw) => {
    expect(parseConversationRef(raw)).toBe(ID);
  });

  it.each([
    [''],
    ['hello'],
    ['abc-123'],
    [`https://chatgpt.com/share/${ID}`],
    ['https://chatgpt.com/g/g-p-68f1c2a01b2c-thesis/project'],
    ['https://chatgpt.com/'],
    [`https://evil.example/c/${ID}`],
    [`https://chatgpt.com.evil.example/c/${ID}`],
    [`http://chatgpt.com/c/${ID}`],
    [`https://chatgpt.com:8443/c/${ID}`],
    ['https://chatgpt.com/c/local-chatgpt:1234'],
    ['https://chatgpt.com/c/..%2Fsettings'],
    [`https://chatgpt.com/c/${ID}/extra`],
  ])('refuses %j as bad-request', (raw) => {
    expect(codeOf(raw)).toBe('bad-request');
  });
});
