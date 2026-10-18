/**
 * `voyager ask --model`: the model is chosen after the tab opens and before
 * anything is attached or sent, and the person's earlier choice comes back
 * after the reply (or after a failure), unless they asked to keep it.
 */
import {
  BRIDGE_PATHS,
  bridgePath,
  type JobSubmitResponse,
  type ModelSelection,
} from '@voyager-crew/bridge-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { askPlugin, type AskInput } from '../../plugins/ask/index';
import { parse, WAIT_OPTIONS } from '../../src/cli/args';
import type { JobDetail } from '../../src/jobs/jobStore';
import type { ForegroundContext } from '../../src/plugins/api';
import { BridgeFailure } from '../../src/util/errors';
import { ASK_HANDLERS, FakeExtension, OpError, pairFake } from '../helpers/fakeExtension';
import { data, errorCode, startTestServer, until, type TestServer } from '../helpers/server';

const MEDIUM: ModelSelection = {
  modelId: 'gpt-6',
  modelLabel: 'GPT-6',
  effortIndex: 1,
  effortMax: 4,
};
const PRO: ModelSelection = { ...MEDIUM, effortIndex: 4 };

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
afterEach(async () => {
  await fake?.stop();
  await t?.close();
  fake = undefined;
  t = undefined;
});

/** The page starts on GPT-6 中; each select moves it and reports what it saw. */
async function setup() {
  t = await startTestServer();
  let current = MEDIUM;
  fake = new FakeExtension(t.port, {
    ...ASK_HANDLERS,
    'model.select': (params) => {
      const { target, capturePrevious } = params as {
        target: { preset?: string; effortIndex?: number };
        capturePrevious?: boolean;
      };
      const previous = current;
      current =
        target.preset === 'pro' ? PRO : { ...current, effortIndex: target.effortIndex ?? 0 };
      return {
        changed: previous.effortIndex !== current.effortIndex,
        ...(capturePrevious ? { previous } : {}),
        observed: current,
        evidence: {},
      };
    },
  });
  await pairFake(fake, t.cli);
  fake.start();
  return { t, fake };
}

async function ask(server: TestServer, input: Partial<AskInput>): Promise<JobDetail> {
  const response = await server.cli('POST', BRIDGE_PATHS.jobs, {
    plugin: 'ask',
    command: 'ask',
    input: { prompt: 'Reply with OK', keepTab: false, ...input },
  });
  const { jobId } = data<JobSubmitResponse>(response);
  let job: JobDetail | undefined;
  await until(async () => {
    job = data<JobDetail>(await server.cli('GET', bridgePath.job(jobId)));
    return ['succeeded', 'failed', 'cancelled', 'needs-user', 'detached'].includes(job.status);
  }, 8_000);
  if (job === undefined) throw new Error('unreachable');
  return job;
}

const ops = (): unknown[] => fake!.tasks.map((task) => task.op);
const selects = (): unknown[] =>
  fake!.tasks.filter((task) => task.op === 'model.select').map((task) => task.params);

const foreground: ForegroundContext = {
  cwd: '/',
  stagingDir: () => Promise.reject(new Error('no staging in this test')),
  note: () => {},
  lastConversation: async () => undefined,
};

function prepareAsk(argv: string[]): Promise<AskInput> {
  const def = askPlugin.commands.ask;
  return def.prepare(foreground, parse(argv, { ...WAIT_OPTIONS, ...def.options }));
}

describe('voyager ask --model', () => {
  it('selects GPT-6 Pro before the send and leaves it selected after the reply', async () => {
    const { t } = await setup();
    const job = await ask(t, await prepareAsk(['Reply with OK']));

    expect(job.status).toBe('succeeded');
    expect(ops()).toEqual([
      'conversation.open',
      'model.select',
      'composer.send',
      'turns.waitReply',
      'turns.read',
      'conversation.close',
    ]);
    expect(selects()).toEqual([{ target: { preset: 'pro' }, capturePrevious: true }]);
    expect(job.result?.model).toEqual({ requested: 'pro', observed: PRO, previous: MEDIUM });
  });

  it('leaves the page as it is with --model current', async () => {
    const { t } = await setup();
    const job = await ask(t, await prepareAsk(['--model', 'current', 'Reply with OK']));

    expect(job.status).toBe('succeeded');
    expect(ops()).not.toContain('model.select');
    expect(job.result?.model).toEqual({ requested: 'current', observed: null, previous: null });
  });

  it('refuses a model name it does not know before anything runs', async () => {
    const error = await prepareAsk(['--model', 'ultra', 'x']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeFailure);
    expect((error as BridgeFailure).code).toBe('bad-request');
  });

  it('leaves Pro selected when the ask fails after selecting it', async () => {
    const { t, fake } = await setup();
    fake.handlers['composer.send'] = () => {
      throw new OpError('composer-busy');
    };
    const job = await ask(t, { model: 'pro' });

    expect(job.error?.code).toBe('composer-busy');
    expect(ops()).toEqual(['conversation.open', 'model.select', 'composer.send']);
  });

  it('refuses up front, naming the missing op, when the extension cannot select models', async () => {
    const { t, fake } = await setup();
    fake.ops = fake.ops.filter((op) => op.name !== 'model.select');
    await fake.stop();
    await fake.poll();

    const response = await t.cli('POST', BRIDGE_PATHS.jobs, {
      plugin: 'ask',
      command: 'ask',
      input: { prompt: 'x', keepTab: false, model: 'pro' },
    });
    expect(errorCode(response)).toBe('unsupported-op');
    expect(JSON.stringify(response.json)).toMatch(/model\.select.*update the Voyager extension/);
    expect(fake.tasks).toEqual([]);
  });
});
