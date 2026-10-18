/**
 * `voyager update` against an in-process serve and a fake extension. npm, the
 * registry and serve restarts are stand-ins: nothing here installs anything.
 */
import {
  BRIDGE_PATHS,
  OP_NAMES,
  type CatalogRefreshResult,
  type JobSubmitResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  INSTALL_COMMAND,
  updateCommand,
  type UpdateDeps,
} from '../../src/cli/commands/update';
import { ServeClient } from '../../src/client/serveClient';
import { ASK_HANDLERS, FakeExtension, pairFake } from '../helpers/fakeExtension';
import { data, startTestServer, until, type TestServer } from '../helpers/server';

const REFRESHED: CatalogRefreshResult = {
  host: 'chatgpt.com',
  status: 'updated',
  revision: 42,
  checkedAt: 1_792_000_000_000,
  extensionVersion: '2.2.0',
};

let t: TestServer | undefined;
let fake: FakeExtension | undefined;
let work: string | undefined;
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await fake?.stop();
  await t?.close();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
  fake = undefined;
  t = undefined;
  work = undefined;
});

function captureOutput() {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  restores.push(() => {
    out.mockRestore();
    err.mockRestore();
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

/** A paired fake extension polling an in-process serve, and an npm global prefix on disk. */
async function setup(
  options: {
    latest?: string | Error;
    env?: NodeJS.ProcessEnv;
    script?: 'global' | 'checkout';
    /** The version of the CLI that runs `voyager update`; serve runs this package's. */
    current?: string;
  } = {},
) {
  t = await startTestServer();
  fake = new FakeExtension(t.port, { ...ASK_HANDLERS, 'catalog.refresh': () => REFRESHED });
  await pairFake(fake, t.cli);
  fake.start();
  const server = t;
  await until(async () => {
    const status = data<StatusResponse>(await server.cli('GET', BRIDGE_PATHS.status));
    return status.extension.lastPollAt !== null;
  });

  work = await mkdtemp(join(tmpdir(), 'voyager-update-'));
  const globalRoot = join(work, 'lib', 'node_modules');
  const scriptDir =
    options.script === 'checkout'
      ? join(work, 'voyager-cli', 'dist')
      : join(globalRoot, '@voyager-crew', 'cli', 'dist');
  await mkdir(scriptDir, { recursive: true });
  await writeFile(join(scriptDir, 'cli.mjs'), '');

  const client = new ServeClient(server.port, server.cliToken);
  const latest = options.latest ?? '0.1.0';
  const run = vi.fn<UpdateDeps['run']>(async (_command, args) =>
    args[0] === 'root' ? { code: 0, stdout: `${globalRoot}\n` } : { code: 0, stdout: '' },
  );
  const restartServe = vi.fn(async () => {});
  const deps: UpdateDeps = {
    currentVersion: options.current ?? '0.1.0',
    fetch: vi.fn(async () => {
      if (latest instanceof Error) throw latest;
      return new Response(JSON.stringify({ name: '@voyager-crew/cli', version: latest }));
    }) as unknown as typeof fetch,
    env: options.env ?? {},
    scriptPath: join(scriptDir, 'cli.mjs'),
    run,
    connect: async () => client,
    ensure: async () => client,
    restartServe,
    pageDataWaitMs: 10_000,
  };
  const output = captureOutput();
  return { server, fake, deps, run, restartServe, output };
}

const installs = (run: ReturnType<typeof vi.fn<UpdateDeps['run']>>) =>
  run.mock.calls.filter(([, args]) => args[0] === 'i');

describe('voyager update', () => {
  it('updates a global install when npm has a newer version', async () => {
    // Newer than this package's own version, which the test serve runs.
    const s = await setup({ latest: '99.0.0' });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(installs(s.run)).toEqual([
      ['npm', ['i', '-g', '@voyager-crew/cli@latest'], { capture: false }],
    ]);
    // serve still runs the old version and is idle: it moves to the new one.
    expect(s.restartServe).toHaveBeenCalledTimes(1);
    expect(s.output.stdout()).toContain('CLI 0.1.0 → 99.0.0 · ');
    expect(s.output.stdout()).toContain('page data refreshed (revision 42) · extension 2.2.0 ✓');
    expect(code).toBe(0);
  });

  it('prints the install command instead under npx', async () => {
    const s = await setup({ latest: '0.2.0', env: { npm_command: 'exec' } });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(installs(s.run)).toEqual([]);
    expect(s.restartServe).not.toHaveBeenCalled();
    expect(s.output.stderr()).toContain(INSTALL_COMMAND);
    expect(code).toBe(0);
  });

  it('prints the install command instead when it runs from a checkout', async () => {
    const s = await setup({ latest: '0.2.0', script: 'checkout' });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(installs(s.run)).toEqual([]);
    expect(s.output.stderr()).toContain(INSTALL_COMMAND);
    expect(code).toBe(0);
  });

  it('moves a serve older than the CLI onto it when the CLI runs from a checkout', async () => {
    const s = await setup({ script: 'checkout', current: '99.0.0', latest: '0.1.0' });
    const code = await updateCommand(s.server.paths, [], s.deps);

    // Without the restart, the old serve refuses the newer CLI's ops (catalog.refresh).
    expect(s.restartServe).toHaveBeenCalledTimes(1);
    expect(s.output.stdout()).toContain(' → 99.0.0');
    expect(code).toBe(0);
  });

  it('asks the extension to refresh the page data', async () => {
    const s = await setup();
    // A stale policy is when the refresh matters most; the extension then offers only it.
    s.fake.policy = { revision: 1, state: 'stale' };
    s.fake.ops = [{ name: 'catalog.refresh', v: 1 }];
    await until(async () => {
      const status = data<StatusResponse>(await s.server.cli('GET', BRIDGE_PATHS.status));
      return status.extension.policy?.state === 'stale';
    });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(s.fake.tasks.map((task) => [task.op, task.params])).toEqual([['catalog.refresh', {}]]);
    expect(s.output.stdout()).toBe(
      'CLI 0.1.0 ✓ · page data refreshed (revision 42) · extension 2.2.0 ✓\n',
    );
    expect(code).toBe(0);
  });

  it('tells the person to update the extension when it does not offer catalog.refresh', async () => {
    const s = await setup();
    s.fake.ops = OP_NAMES.filter((op) => op !== 'catalog.refresh').map((name) => ({ name, v: 1 }));
    await until(async () => {
      const listed = data<{ ops: { name: string }[] }>(
        await s.server.cli('GET', BRIDGE_PATHS.commands),
      );
      return !listed.ops.some((op) => op.name === 'catalog.refresh');
    });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(s.fake.tasks).toEqual([]);
    expect(s.output.stdout()).toContain(
      'extension 2.1.0: update the Voyager extension in your browser',
    );
    expect(code).toBe(0);
  });

  it('does not restart serve while a job runs', async () => {
    const s = await setup({ latest: '99.0.0' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.fake.handlers = {
      ...s.fake.handlers,
      'project.list': async () => {
        await held;
        return { projects: [], evidence: {} };
      },
    };
    const { jobId } = data<JobSubmitResponse>(
      await s.server.cli('POST', BRIDGE_PATHS.call, { op: 'project.list', params: {} }),
    );
    await until(() => s.fake?.tasks.some((task) => task.op === 'project.list') === true);

    const code = await updateCommand(s.server.paths, [], s.deps);
    release();

    expect(s.restartServe).not.toHaveBeenCalled();
    expect(s.output.stdout()).toContain(
      'CLI 0.1.0 → 99.0.0 · restart voyager serve after the current job',
    );
    // One job at a time: the refresh waits for a later run too, and says so.
    expect(s.output.stderr()).toContain(`job ${jobId} is running`);
    expect(code).toBe(5);
  });

  it('says the registry is unreachable and still refreshes the page data', async () => {
    const s = await setup({ latest: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') });
    const code = await updateCommand(s.server.paths, [], s.deps);

    expect(s.output.stderr()).toContain('could not reach the npm registry');
    expect(s.output.stdout()).toContain('page data refreshed (revision 42)');
    expect(installs(s.run)).toEqual([]);
    expect(code).toBe(6);
  });
});

describe('compareVersions', () => {
  it('orders release numbers numerically and a release after its prereleases', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
  });
});
