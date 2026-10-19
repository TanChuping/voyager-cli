import { describe, expect, it } from 'vitest';

import {
  checkRepoReach,
  parseRepo,
  REPO_UNREACHABLE,
  repoPromptBlock,
} from '../../plugins/ask/repo';
import { BridgeFailure } from '../../src/util/errors';

const now = new Date('2026-10-19T14:25:01Z');

describe('ask --repo', () => {
  it('reads owner/name, owner/name@ref and github.com links', () => {
    expect(parseRepo('Nagi-ovo/voyager-gh-test', now, 'ab12')).toEqual({
      fullName: 'Nagi-ovo/voyager-gh-test',
      branch: 'chatgpt/20261019-1425-ab12',
    });
    expect(parseRepo('Nagi-ovo/voyager-gh-test@dev', now, 'ab12').ref).toBe('dev');
    expect(parseRepo('https://github.com/Nagi-ovo/voyager-gh-test.git', now, 'ab12').fullName).toBe(
      'Nagi-ovo/voyager-gh-test',
    );
    expect(parseRepo('https://github.com/Nagi-ovo/voyager-gh-test/tree/dev', now, 'ab12').ref).toBe(
      'dev',
    );
  });

  it('rejects anything that is not a repository', () => {
    for (const raw of ['voyager-gh-test', 'a/b/c', 'Nagi-ovo/voyager-gh-test@', '../x']) {
      expect(() => parseRepo(raw, now)).toThrow(BridgeFailure);
    }
  });

  it('names the branch to write to and the line to open with when the repo is out of reach', () => {
    const block = repoPromptBlock(parseRepo('Nagi-ovo/voyager-gh-test', now, 'ab12'));
    expect(block).toContain('`chatgpt/20261019-1425-ab12`');
    expect(block).toContain(REPO_UNREACHABLE);
  });

  it('fails with permission-missing when the reply opens with the marker', () => {
    const target = parseRepo('Nagi-ovo/voyager-gh-test', now, 'ab12');
    const reply = (markdown: string) => ({
      data: { response: { markdown }, responsePath: '/tmp/response.md' },
    });

    expect(() => checkRepoReach(target, reply('Here is the review.'))).not.toThrow();
    // The marker mentioned later in a normal reply is not a report.
    expect(() => checkRepoReach(target, reply(`All good.\n\n${REPO_UNREACHABLE}`))).not.toThrow();
    for (const opening of [
      REPO_UNREACHABLE,
      `**${REPO_UNREACHABLE}**`,
      `\`${REPO_UNREACHABLE}\``,
      `${REPO_UNREACHABLE}:`,
    ]) {
      const error = (() => {
        try {
          checkRepoReach(target, reply(`${opening}\n404 Not Found`));
        } catch (thrown) {
          return thrown;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(BridgeFailure);
      expect((error as BridgeFailure).code).toBe('permission-missing');
      expect((error as BridgeFailure).message).toContain('github.com/settings/installations');
    }
  });
});
