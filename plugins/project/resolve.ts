/**
 * A project as a person names it: its id (`g-p-<32 hex>`), a chatgpt.com link
 * into it, or its name as the sidebar shows it. A name is looked up on the
 * page (`project.list`); two projects with that name are refused with both ids.
 */
import { PROJECT_ID_PATTERN, type ProjectSummary } from '@voyager-crew/bridge-protocol';

import type { JobContext } from '../../src/plugins/api';
import { failure } from '../../src/util/errors';
import { callProjectOp } from './ops';

const ID_IN_PATH = /\/g\/(g-p-[0-9a-f]{32})(?:[-/?#]|$)/;

/** The id `ref` spells out, or undefined when it is a name. */
export function projectIdIn(ref: string): string | undefined {
  const text = ref.trim();
  if (PROJECT_ID_PATTERN.test(text)) return text;
  if (!/^(?:https:\/\/)?(?:chatgpt\.com|chat\.openai\.com)\//.test(text)) return undefined;
  return ID_IN_PATH.exec(text)?.[1];
}

export interface ResolvedProject {
  readonly projectId: string;
  /** The sidebar's name, when it was looked up. */
  readonly name?: string;
}

export function pickProject(ref: string, projects: readonly ProjectSummary[]): ResolvedProject {
  const name = ref.trim();
  const found = projects.filter((project) => project.name === name);
  if (found.length === 1) return { projectId: found[0].projectId, name };
  if (found.length > 1) {
    throw failure(
      'bad-request',
      `${found.length} projects are named ${JSON.stringify(name)}: ${found
        .map((project) => project.projectId)
        .join(', ')}. Give the id instead`,
      { ids: found.map((project) => project.projectId) },
    );
  }
  throw failure(
    'not-found',
    `no project named ${JSON.stringify(name)} in the ChatGPT sidebar; see voyager project list, or give its id (g-p-…)`,
    { known: projects.map((project) => project.name) },
  );
}

/** `ref` as a project id, asking the page for its projects only when `ref` is a name. */
export async function resolveProject(ctx: JobContext, ref: string): Promise<ResolvedProject> {
  const id = projectIdIn(ref);
  if (id !== undefined) return { projectId: id };
  const { projects } = await callProjectOp(ctx, 'project.list', {});
  return pickProject(ref, projects);
}
