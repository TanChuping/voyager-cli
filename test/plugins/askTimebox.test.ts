import { describe, expect, it } from 'vitest';

import { parseTimebox, timeboxPromptBlock } from '../../plugins/ask/timebox';
import { BridgeFailure } from '../../src/util/errors';

describe('ask --timebox', () => {
  it('takes whole minutes, with or without an m', () => {
    expect(parseTimebox(undefined)).toBeUndefined();
    expect(parseTimebox('70')).toBe(70);
    expect(parseTimebox('45m')).toBe(45);
  });

  it('refuses what is not a sensible countdown', () => {
    for (const raw of ['', 'soon', '1h', '1.5', '0', '4', '601', '-70']) {
      expect(() => parseTimebox(raw)).toThrow(BridgeFailure);
    }
  });

  it('asks ChatGPT to wrap up at that minute and hand over finished and unfinished work apart', () => {
    const block = timeboxPromptBlock(70);
    expect(block).toContain('70-minute countdown');
    expect(block).toContain('finished/');
    expect(block).toContain('unfinished/');
    expect(block).toContain('/mnt/data/');
    expect(timeboxPromptBlock(50)).toContain('When the 50 minutes are up');
  });
});
