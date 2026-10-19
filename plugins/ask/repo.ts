/**
 * `ask --repo <owner/name[@ref]>`: point ChatGPT's GitHub app at a repository.
 * The prompt asks it to read the repository and to commit only to a fresh
 * `chatgpt/<time>-<id>` branch. That is a request to the model, not a rule
 * anything enforces: the app can write wherever its installation reaches.
 *
 * Whether the app reaches the repository is GitHub's setting, not ours. The
 * prompt asks ChatGPT to open its reply with {@link REPO_UNREACHABLE} when it
 * cannot; that reply fails the job with `permission-missing` (exit 3).
 */
import { randomBytes } from 'node:crypto';

import type { JobResult } from '../../src/plugins/api';
import { failure } from '../../src/util/errors';
import { isRecord } from '../../src/util/isRecord';

export const REPO_UNREACHABLE = 'VOYAGER-REPO-UNREACHABLE';

const INSTALLATIONS_URL = 'https://github.com/settings/installations';

export interface RepoTarget {
  /** `owner/name`. */
  readonly fullName: string;
  /** The ref to read and branch from; the default branch when absent. */
  readonly ref?: string;
  /** The only branch ChatGPT is asked to write to. */
  readonly branch: string;
}

const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name`, `owner/name@ref` or a github.com link to the repository. */
export function parseRepo(
  raw: string,
  now: Date = new Date(),
  random = randomBytes(2).toString('hex'),
): RepoTarget {
  let text = raw.trim();
  const link =
    /^(?:https?:\/\/)?github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:\/tree\/([^#?]+))?\/?$/.exec(text);
  if (link !== null) text = link[2] === undefined ? link[1]! : `${link[1]!}@${link[2]}`;
  const at = text.indexOf('@');
  const fullName = at === -1 ? text : text.slice(0, at);
  const ref = at === -1 ? undefined : text.slice(at + 1).trim();
  if (!FULL_NAME.test(fullName) || ref === '') {
    throw failure(
      'bad-request',
      `--repo takes owner/name or owner/name@ref, not ${JSON.stringify(raw)}`,
    );
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  return { fullName, ...(ref === undefined ? {} : { ref }), branch: `chatgpt/${stamp}-${random}` };
}

export function repoPromptBlock(target: RepoTarget): string {
  const base = target.ref === undefined ? 'its default branch' : `\`${target.ref}\``;
  return [
    `GitHub repository: ${target.fullName}. Read it from ${base} with the GitHub tool.`,
    `If you change any file, first create the branch \`${target.branch}\` from ${base}, commit only to that branch, and report the branch and every commit SHA. Leave every other branch as it is.`,
    `If the GitHub tool cannot reach this repository, make the first line of your reply exactly ${REPO_UNREACHABLE}, then give the error you got.`,
  ].join('\n');
}

/** True when the reply opens with the marker, however the page formatted that line. */
export function saysRepoUnreachable(markdown: string): boolean {
  const first = markdown.trimStart().split('\n', 1)[0] ?? '';
  return first.replace(/[`*_>#\s:.]/g, '') === REPO_UNREACHABLE;
}

/** Fails the job when ChatGPT reports the repository out of its GitHub app's reach. */
export function checkRepoReach(target: RepoTarget, result: JobResult): void {
  const data = isRecord(result.data) ? result.data : {};
  const response = isRecord(data.response) ? data.response : {};
  if (typeof response.markdown !== 'string' || !saysRepoUnreachable(response.markdown)) return;
  const responsePath = typeof data.responsePath === 'string' ? data.responsePath : undefined;
  throw failure(
    'permission-missing',
    `ChatGPT's GitHub app cannot reach ${target.fullName}. Give it access at ${INSTALLATIONS_URL} ` +
      `(ChatGPT Codex Connector → Repository access), then ask again.` +
      (responsePath === undefined ? '' : ` Its reply is saved at ${responsePath}.`),
    {
      repo: target.fullName,
      ...(responsePath === undefined ? {} : { responsePath }),
      ...(typeof data.conversationUrl === 'string'
        ? { conversationUrl: data.conversationUrl }
        : {}),
    },
  );
}
