/**
 * `voyager project …` and `voyager ask --project` against the fake extension:
 * which ops each runs, in what order, how a name becomes an id, and how an
 * upload replaces a file ChatGPT would otherwise silently keep.
 */
import {
  BRIDGE_PATHS,
  bridgePath,
  isOpName,
  PROJECT_OP_NAMES,
  type JobSubmitResponse,
  type OpName,
} from '@voyager-crew/bridge-protocol';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { askPlugin, type AskInput } from '../../plugins/ask/index';
import { projectPlugin, type ProjectInput } from '../../plugins/project/index';
import { parse, WAIT_OPTIONS } from '../../src/cli/args';
import { exitForError } from '../../src/cli/exitCodes';
import type { JobDetail } from '../../src/jobs/jobStore';
import type { ForegroundContext } from '../../src/plugins/api';
import { stageAttachments, type StagedAttachment } from '../../src/util/attach/stage';
import { BridgeFailure } from '../../src/util/errors';
import {
  ASK_HANDLERS,
  FakeExtension,
  OpError,
  pairFake,
  type OpHandler,
} from '../helpers/fakeExtension';
import { data, startTestServer, until, type TestServer } from '../helpers/server';

/** The project ops reach the extension once their registration lists them in `OpName`. */
const registered = PROJECT_OP_NAMES.every((op) => isOpName(op));

const A = `g-p-${'a1'.repeat(16)}`;
const B = `g-p-${'b2'.repeat(16)}`;
const B2 = `g-p-${'c3'.repeat(16)}`;
const CONV = '6ad3f5e3-4464-43ed-8167-4abe151af1ff';

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
const made: string[] = [];
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A ChatGPT with projects A and two named 实验记录, and the files given per project. */
function projectHandlers(files: Record<string, string[]>): Record<string, OpHandler> {
  const listOf = (projectId: string) =>
    (files[projectId] ?? []).map((name) => ({ name, uploadedAt: '2026-10-18T08:00:00.000Z' }));
  return {
    'project.list': () => ({
      projects: [
        { projectId: A, name: '论文 Q3' },
        { projectId: B, name: '实验记录' },
        { projectId: B2, name: '实验记录' },
      ],
      evidence: {},
    }),
    'project.open': (params) => {
      const { projectId, view } = params as { projectId: string; view: string };
      return {
        projectId,
        url: `https://chatgpt.com/g/${projectId}/project${view === 'sources' ? '?tab=sources' : ''}`,
        view,
        name: null,
        evidence: {},
      };
    },
    'project.files': (params) => {
      const { projectId } = params as { projectId: string };
      return { projectId, files: listOf(projectId) };
    },
    'project.upload': (params) => {
      const { projectId, blob } = params as { projectId: string; blob: { name: string } };
      // Like ChatGPT: a name already held is ignored, so the file would be listed once anyway.
      files[projectId] = [...new Set([...(files[projectId] ?? []), blob.name])];
      const uploaded = { name: blob.name, uploadedAt: '2026-10-18T09:00:00.000Z' };
      return { projectId, uploaded, files: listOf(projectId), evidence: {} };
    },
    'project.remove': (params) => {
      const { projectId, name } = params as { projectId: string; name: string };
      if (!(files[projectId] ?? []).includes(name)) throw new OpError('not-found');
      files[projectId] = files[projectId].filter((file) => file !== name);
      return { projectId, removed: name, files: listOf(projectId), evidence: {} };
    },
    'project.create': (params) => ({
      projectId: `g-p-${'d4'.repeat(16)}`,
      name: (params as { name: string }).name,
      url: `https://chatgpt.com/g/g-p-${'d4'.repeat(16)}/project`,
      evidence: {},
    }),
  };
}

async function setup(files: Record<string, string[]> = {}) {
  t = await startTestServer();
  fake = new FakeExtension(t.port, {
    ...ASK_HANDLERS,
    ...(projectHandlers(files) as Partial<Record<OpName, OpHandler>>),
    'composer.send': () => ({
      conversationId: CONV,
      url: `https://chatgpt.com/g/${A}-lun-wen/c/${CONV}`,
      userTurnKey: 't-9',
    }),
  });
  await pairFake(fake, t.cli);
  fake.start();
  return { t, fake };
}

async function submit(server: TestServer, plugin: string, input: unknown): Promise<string> {
  const response = await server.cli('POST', BRIDGE_PATHS.jobs, { plugin, command: plugin, input });
  return data<JobSubmitResponse>(response).jobId;
}

async function finished(server: TestServer, jobId: string): Promise<JobDetail> {
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return ['succeeded', 'failed', 'cancelled', 'needs-user', 'detached'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

function foreground(overrides: Partial<ForegroundContext> = {}): ForegroundContext {
  return {
    cwd: '/',
    stagingDir: () => Promise.reject(new Error('no staging in this test')),
    note: () => {},
    lastConversation: async () => undefined,
    ...overrides,
  };
}

function prepareProject(argv: string[], fg: ForegroundContext): Promise<ProjectInput> {
  const def = projectPlugin.commands.project;
  return def.prepare(fg, parse(argv, { ...WAIT_OPTIONS, ...def.options }));
}

function prepareAsk(argv: string[], fg: ForegroundContext): Promise<AskInput> {
  const def = askPlugin.commands.ask;
  return def.prepare(fg, parse(argv, { ...WAIT_OPTIONS, ...def.options }));
}

async function failureOf(work: Promise<unknown>): Promise<BridgeFailure | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof BridgeFailure) return error;
    throw error;
  }
  return undefined;
}

async function staged(
  server: TestServer,
  name: string,
  content: string,
): Promise<StagedAttachment> {
  const source = await mkdtemp(join(tmpdir(), 'voyager-upload-'));
  made.push(source);
  await writeFile(join(source, name), content);
  const dir = join(server.paths.staging, `s-${made.length}-${content.length}`);
  await mkdir(dir, { recursive: true });
  const [file] = await stageAttachments([join(source, name)], {
    cwd: '/',
    stagingDir: async () => dir,
    note: () => {},
  });
  return file;
}

const ops = (server: FakeExtension): string[] => server.tasks.map((task) => task.op);
/** A project op as the fake's handler table names it, before the registration. */
const opName = (name: string): OpName => name as OpName;

describe('voyager project: preparing', () => {
  it('packs a folder upload as <folder>.zip without its credentials', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'voyager-proj-'));
    made.push(parent);
    await mkdir(join(parent, 'thesis', 'src'), { recursive: true });
    await writeFile(join(parent, 'thesis', 'src', 'main.tex'), '\\documentclass{article}\n');
    await writeFile(join(parent, 'thesis', '.env'), 'TOKEN=1');
    const staging = await mkdtemp(join(tmpdir(), 'voyager-staging-'));
    made.push(staging);
    const input = await prepareProject(
      ['upload', '论文 Q3', join(parent, 'thesis')],
      foreground({ stagingDir: async () => staging }),
    );

    expect(input).toMatchObject({
      action: 'upload',
      project: '论文 Q3',
      upload: { name: 'thesis.zip', kind: 'folder', fileCount: 1 },
    });
  });

  it('refuses to remove without --yes when nobody is at a terminal to confirm', async () => {
    const refused = await failureOf(
      prepareProject(['remove', '论文 Q3', 'notes.md'], foreground()),
    );

    expect(refused?.code).toBe('bad-request');
    expect(refused?.message).toContain('--yes');
    expect(exitForError(refused!.error)).toBe(2);
  });

  it('asks on a terminal before a removal and keeps the file on a no', async () => {
    const questions: string[] = [];
    const confirm = async (question: string) => {
      questions.push(question);
      return false;
    };
    const declined = await failureOf(
      prepareProject(['remove', '论文 Q3', 'notes.md'], foreground({ confirm })),
    );

    expect(declined?.code).toBe('cancelled');
    expect(questions[0]).toContain('cannot be undone');
    expect(
      await prepareProject(['remove', '论文 Q3', 'notes.md', '--yes'], foreground({ confirm })),
    ).toMatchObject({ action: 'remove', project: '论文 Q3', name: 'notes.md' });
    expect(questions).toHaveLength(1);
  });

  it('refuses ask --project beside --chat or --continue', async () => {
    const refused = await failureOf(
      prepareAsk(['hi', '--project', '论文 Q3', '--chat', CONV], foreground()),
    );
    expect(refused?.code).toBe('bad-request');
  });
});

describe.runIf(registered)('voyager project: jobs', () => {
  it('lists the projects and closes its tab', async () => {
    const { t, fake } = await setup();
    const job = await finished(t, await submit(t, 'project', { action: 'list', keepTab: false }));

    expect(job.status).toBe('succeeded');
    expect(job.result?.projects).toHaveLength(3);
    expect(ops(fake)).toEqual(['conversation.open', 'project.list', 'conversation.close']);
    expect(fake.protocolErrors).toEqual([]);
  });

  it('refuses a name two projects share, naming both ids, and touches no files', async () => {
    const { t, fake } = await setup();
    const job = await finished(
      t,
      await submit(t, 'project', { action: 'files', project: '实验记录', keepTab: false }),
    );

    expect(job.error?.code).toBe('bad-request');
    expect(job.error?.message).toContain(B);
    expect(job.error?.message).toContain(B2);
    expect(ops(fake)).toEqual(['conversation.open', 'project.list']);
  });

  it('opens a project given by id without listing, and reads its files', async () => {
    const { t, fake } = await setup({ [A]: ['repo.zip'] });
    const job = await finished(
      t,
      await submit(t, 'project', { action: 'files', project: A, keepTab: false }),
    );

    expect(job.result?.files).toEqual([
      { name: 'repo.zip', uploadedAt: '2026-10-18T08:00:00.000Z' },
    ]);
    expect(fake.tasks.slice(1, 3).map((task) => [task.op, task.params])).toEqual([
      ['project.open', { projectId: A, view: 'sources' }],
      ['project.files', { projectId: A }],
    ]);
  });

  it('refuses to create a second project under a name in use', async () => {
    const { t, fake } = await setup();
    const job = await finished(
      t,
      await submit(t, 'project', { action: 'create', name: '论文 Q3', keepTab: false }),
    );

    expect(job.error?.code).toBe('bad-request');
    expect(ops(fake)).not.toContain('project.create');
  });

  it('uploads a new file, then skips it while its content is unchanged', async () => {
    const { t, fake } = await setup({ [A]: [] });
    const first = await finished(
      t,
      await submit(t, 'project', {
        action: 'upload',
        project: '论文 Q3',
        upload: await staged(t, 'notes.md', 'v1'),
        keepTab: false,
      }),
    );
    expect(first.result).toMatchObject({ outcome: 'uploaded', name: 'notes.md' });

    const before = fake.tasks.length;
    const second = await finished(
      t,
      await submit(t, 'project', {
        action: 'upload',
        project: '论文 Q3',
        upload: await staged(t, 'notes.md', 'v1'),
        keepTab: false,
      }),
    );
    expect(second.result).toMatchObject({ outcome: 'unchanged' });
    const later = fake.tasks.slice(before).map((task) => task.op);
    expect(later).not.toContain('project.upload');
    expect(later).not.toContain('project.remove');
  });

  it('replaces a changed file: removes the copy ChatGPT would keep, then uploads', async () => {
    const { t, fake } = await setup({ [A]: [] });
    await finished(
      t,
      await submit(t, 'project', {
        action: 'upload',
        project: A,
        upload: await staged(t, 'notes.md', 'v1'),
        keepTab: false,
      }),
    );
    const before = fake.tasks.length;
    const job = await finished(
      t,
      await submit(t, 'project', {
        action: 'upload',
        project: A,
        upload: await staged(t, 'notes.md', 'version two'),
        keepTab: false,
      }),
    );

    expect(job.result).toMatchObject({ outcome: 'replaced', replacedUnknown: false });
    expect(fake.tasks.slice(before).map((task) => task.op)).toEqual([
      'conversation.open',
      'project.open',
      'project.files',
      'project.remove',
      'project.upload',
      'conversation.close',
    ]);
  });

  it('replaces a listed file this machine never uploaded, and says so', async () => {
    const { t } = await setup({ [A]: ['notes.md'] });
    const job = await finished(
      t,
      await submit(t, 'project', {
        action: 'upload',
        project: A,
        upload: await staged(t, 'notes.md', 'mine'),
        keepTab: false,
      }),
    );

    expect(job.result).toMatchObject({ outcome: 'replaced', replacedUnknown: true });
  });

  it('removes a file and forgets its fingerprint, so the next upload sends it again', async () => {
    const { t, fake } = await setup({ [A]: [] });
    const upload = async () =>
      finished(
        t,
        await submit(t, 'project', {
          action: 'upload',
          project: A,
          upload: await staged(t, 'notes.md', 'v1'),
          keepTab: false,
        }),
      );
    await upload();
    const removed = await finished(
      t,
      await submit(t, 'project', {
        action: 'remove',
        project: A,
        name: 'notes.md',
        keepTab: false,
      }),
    );
    expect(removed.result).toMatchObject({ outcome: 'removed', name: 'notes.md' });
    expect(await upload()).toMatchObject({ result: { outcome: 'uploaded' } });
    expect(ops(fake).filter((op) => op === 'project.upload')).toHaveLength(2);
  });
});

describe.runIf(registered)('voyager ask --project', () => {
  it('opens the project in chat mode before choosing the model, then sends there', async () => {
    const { t, fake } = await setup();
    const job = await finished(
      t,
      await submit(t, 'ask', { prompt: 'read repo.zip', keepTab: false, project: '论文 Q3' }),
    );

    expect(job.status).toBe('succeeded');
    expect(fake.tasks.slice(0, 4).map((task) => [task.op, task.params])).toEqual([
      ['conversation.open', { new: true }],
      ['project.list', {}],
      ['project.open', { projectId: A, view: 'chat' }],
      ['model.select', { target: { preset: 'pro' }, capturePrevious: true }],
    ]);
    expect(job.result?.conversationUrl).toBe(`https://chatgpt.com/g/${A}-lun-wen/c/${CONV}`);
  });

  it('sends nothing when the project cannot be put in chat mode', async () => {
    const { t, fake } = await setup();
    fake.handlers[opName('project.open')] = () => {
      throw new OpError('mode-unavailable');
    };
    const job = await finished(
      t,
      await submit(t, 'ask', { prompt: 'hi', keepTab: false, project: A }),
    );

    expect(job.status).toBe('needs-user');
    expect(ops(fake)).not.toContain('composer.send');
    expect(ops(fake)).not.toContain('model.select');
  });
});
