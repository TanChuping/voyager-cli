/**
 * `voyager update`: update every part that can be updated from here, then print
 * one line that says where each part stands.
 *
 * 1. The CLI, when npm installed it globally. Under npx or from a checkout the
 *    install command is printed instead.
 * 2. `voyager serve`, restarted onto the new version unless a job is running.
 * 3. The page data: the extension re-fetches its site data now (`catalog.refresh`)
 *    instead of at its next scheduled check.
 * 4. The extension: the browser's store updates it; this only reports it.
 */
import {
  BRIDGE_PATHS,
  type CatalogRefreshResult,
  type JobSubmitResponse,
  type StatusResponse,
} from '@voyager-crew/bridge-protocol';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { connectServe, ensureServe, type ServeClient } from '../../client/serveClient';
import type { StatePaths } from '../../state/paths';
import { BridgeFailure, toBridgeError } from '../../util/errors';
import { isRecord } from '../../util/isRecord';
import { CLI_VERSION } from '../../version';
import { parse } from '../args';
import { EXIT, exitForError, exitForJob } from '../exitCodes';
import { note, printJson, printLine } from '../output';
import { waitForJob } from '../waitJob';
import { warnIfExtensionAway } from './info';
import { stopServe } from './serve';

export const CLI_PACKAGE = '@voyager-crew/cli';
export const INSTALL_COMMAND = `npm i -g ${CLI_PACKAGE}@latest`;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
/** The extension may take its one-minute wake alarm to reach a serve that just started. */
const PAGE_DATA_WAIT_MS = 2 * 60_000;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
}

export interface UpdateDeps {
  readonly currentVersion: string;
  readonly fetch: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  /** The script this process runs (`process.argv[1]`). */
  readonly scriptPath: string | undefined;
  /** `capture`: return stdout; otherwise the command's output goes to stderr. */
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly capture: boolean },
  ) => Promise<RunResult>;
  /** A running serve, or undefined; never starts one. */
  readonly connect: () => Promise<ServeClient | undefined>;
  /** A running serve, started when none runs. */
  readonly ensure: () => Promise<ServeClient>;
  readonly restartServe: () => Promise<void>;
  readonly pageDataWaitMs: number;
}

export function defaultUpdateDeps(paths: StatePaths): UpdateDeps {
  return {
    currentVersion: CLI_VERSION,
    fetch: (...args) => fetch(...args),
    env: process.env,
    scriptPath: process.argv[1],
    run: runCommand,
    connect: () => connectServe(paths),
    ensure: () => ensureServe(paths),
    restartServe: async () => {
      if ((await stopServe(paths)) !== 0) throw new Error('the running voyager serve did not stop');
      await ensureServe(paths);
    },
    pageDataWaitMs: PAGE_DATA_WAIT_MS,
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly capture: boolean },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // stdout stays ours: npm's own output goes to stderr with the other notes.
    const child = spawn(command, [...args], {
      stdio: options.capture ? ['ignore', 'pipe', 'ignore'] : ['ignore', 2, 2],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** Semver order, enough for release tags: `1.2.10 > 1.2.9`, `1.0.0 > 1.0.0-rc.1`. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const [core = '', pre] = version.trim().replace(/^v/, '').split('+')[0].split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

type InstallKind =
  | { readonly kind: 'global' }
  | { readonly kind: 'npx' }
  | { readonly kind: 'local'; readonly path: string };

const resolved = (path: string): Promise<string> => realpath(path).catch(() => path);

async function detectInstall(deps: UpdateDeps): Promise<InstallKind> {
  if (deps.scriptPath === undefined) return { kind: 'local', path: '?' };
  const script = await resolved(deps.scriptPath);
  // npx runs packages from npm's `_npx` cache, and `npm exec` marks its environment.
  if (script.split(sep).includes('_npx') || deps.env.npm_command === 'exec') return { kind: 'npx' };
  try {
    const root = await deps.run('npm', ['root', '-g'], { capture: true });
    const globalRoot = root.stdout.trim();
    if (root.code === 0 && globalRoot !== '') {
      const installed = await resolved(join(globalRoot, ...CLI_PACKAGE.split('/')));
      if (script.startsWith(`${installed}${sep}`)) return { kind: 'global' };
    }
  } catch {
    // No npm on PATH: this copy cannot be npm's global install.
  }
  return { kind: 'local', path: script };
}

async function latestVersion(deps: UpdateDeps): Promise<string> {
  const registry = deps.env.npm_config_registry ?? DEFAULT_REGISTRY;
  const url = `${registry.replace(/\/?$/, '/')}${CLI_PACKAGE.replace('/', '%2F')}/latest`;
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.version !== 'string') {
    throw new Error('the registry answered without a version');
  }
  return body.version;
}

interface Step {
  /** The summary line's part. */
  readonly line: string;
  readonly code: number;
}

interface CliStep extends Step {
  readonly json: Readonly<Record<string, unknown>>;
  /** The version serve should run now; undefined when this run cannot restart it. */
  readonly serveTarget?: string;
}

async function updateCli(deps: UpdateDeps): Promise<CliStep> {
  const current = deps.currentVersion;
  let latest: string;
  try {
    latest = await latestVersion(deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    note(`could not reach the npm registry (${reason}); the CLI was not checked`);
    return {
      line: `CLI ${current} (not checked: offline?)`,
      code: EXIT.transient,
      json: { version: current, latest: null, error: reason },
    };
  }
  const install = await detectInstall(deps);
  const newer = compareVersions(latest, current) > 0;
  const json = { version: current, latest, install: install.kind };
  if (install.kind === 'npx') {
    if (newer)
      note(`npx ran ${current}: use npx ${CLI_PACKAGE}@latest, or install it: ${INSTALL_COMMAND}`);
    return {
      line: newer ? `CLI ${current} (${latest} via npx ${CLI_PACKAGE}@latest)` : `CLI ${current} ✓`,
      code: EXIT.ok,
      json: { ...json, updated: false },
    };
  }
  if (install.kind === 'local') {
    if (newer) note(`this CLI runs from ${install.path}; to install ${latest}: ${INSTALL_COMMAND}`);
    return {
      line: newer ? `CLI ${current} (${latest} out: ${INSTALL_COMMAND})` : `CLI ${current} ✓`,
      code: EXIT.ok,
      json: { ...json, updated: false },
    };
  }
  if (!newer) {
    return {
      line: `CLI ${current} ✓`,
      code: EXIT.ok,
      json: { ...json, updated: false },
      serveTarget: current,
    };
  }
  note(`CLI ${current} → ${latest}: ${INSTALL_COMMAND}`);
  let installed: RunResult;
  try {
    installed = await deps.run('npm', ['i', '-g', `${CLI_PACKAGE}@latest`], { capture: false });
  } catch (error) {
    note(`could not run npm: ${String(error)}`);
    installed = { code: 1, stdout: '' };
  }
  if (installed.code !== 0) {
    note(`npm exited ${installed.code}; run it yourself: ${INSTALL_COMMAND}`);
    return {
      line: `CLI ${current} (update failed)`,
      code: EXIT.failed,
      json: { ...json, updated: false },
      serveTarget: current,
    };
  }
  return {
    line: `CLI ${current} → ${latest}`,
    code: EXIT.ok,
    json: { ...json, updated: true },
    serveTarget: latest,
  };
}

async function restartServe(
  deps: UpdateDeps,
  target: string | undefined,
): Promise<Step | undefined> {
  if (target === undefined) return undefined;
  const client = await deps.connect().catch(() => undefined);
  // Not running: the next command starts the installed version.
  if (client === undefined) return undefined;
  const status = await client.request<StatusResponse>('GET', BRIDGE_PATHS.status);
  if (status.serverVersion === target) return undefined;
  if (status.activeJob !== undefined) {
    note(
      `voyager serve still runs ${status.serverVersion}: job ${status.activeJob.jobId} is running`,
    );
    return { line: 'restart voyager serve after the current job', code: EXIT.ok };
  }
  try {
    await deps.restartServe();
  } catch (error) {
    note(`could not restart voyager serve: ${String(error)}; run voyager serve --stop`);
    return { line: 'serve not restarted', code: EXIT.transient };
  }
  return { line: `serve ${status.serverVersion} → ${target}`, code: EXIT.ok };
}

interface PageStep extends Step {
  readonly result?: CatalogRefreshResult;
  readonly unsupported: boolean;
  readonly error?: unknown;
}

function isRefreshResult(value: unknown): value is CatalogRefreshResult {
  return isRecord(value) && typeof value.status === 'string' && typeof value.host === 'string';
}

/** `voyager call catalog.refresh`, through the same job and op plumbing. */
async function refreshPageData(deps: UpdateDeps): Promise<PageStep> {
  let client: ServeClient;
  let jobId: string;
  try {
    client = await deps.ensure();
    await warnIfExtensionAway(client);
    ({ jobId } = await client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.call, {
      op: 'catalog.refresh',
      params: {},
    }));
  } catch (thrown) {
    const error = toBridgeError(thrown);
    if (thrown instanceof BridgeFailure && error.code === 'busy') {
      const active = String(error.details?.activeJobId ?? '?');
      note(`job ${active} is running and jobs are not queued; run voyager update again after it`);
      return {
        line: 'page data not refreshed (a job is running)',
        code: EXIT.busy,
        unsupported: false,
        error,
      };
    }
    note(`page data: ${error.code}: ${error.message}`);
    return {
      line: `page data not refreshed (${error.code})`,
      code: exitForError(error),
      unsupported: false,
      error,
    };
  }
  const outcome = await waitForJob(client, jobId, deps.pageDataWaitMs);
  const job = outcome.job;
  if (outcome.kind === 'timeout') {
    note(`the extension has not answered yet; job ${jobId} continues (voyager job wait ${jobId})`);
    return {
      line: 'page data: waiting for the extension',
      code: EXIT.waitTimeout,
      unsupported: false,
    };
  }
  if (job.status !== 'succeeded') {
    if (job.error?.code === 'unsupported-op') {
      return {
        line: 'page data needs a newer extension',
        code: EXIT.ok,
        unsupported: true,
        error: job.error,
      };
    }
    note(`page data: ${job.error?.code ?? job.status}: ${job.error?.message ?? ''}`);
    return {
      line: `page data not refreshed (${job.error?.code ?? job.status})`,
      code: exitForJob(job),
      unsupported: false,
      error: job.error,
    };
  }
  const result = job.result?.result;
  if (!isRefreshResult(result)) {
    return { line: 'page data: no result', code: EXIT.failed, unsupported: false };
  }
  const revision = result.revision === null ? '' : ` (revision ${result.revision})`;
  switch (result.status) {
    case 'updated':
      return { line: `page data refreshed${revision}`, code: EXIT.ok, result, unsupported: false };
    case 'unchanged':
      return { line: `page data up to date${revision}`, code: EXIT.ok, result, unsupported: false };
    case 'missing':
      return {
        line: `no page data published for ${result.host}`,
        code: EXIT.ok,
        result,
        unsupported: false,
      };
    case 'disabled':
      return {
        line: 'this extension build has no online page data',
        code: EXIT.ok,
        result,
        unsupported: false,
      };
    case 'failed':
      note(`the extension could not fetch the page data: ${result.reason ?? 'unknown error'}`);
      return { line: 'page data refresh failed', code: EXIT.transient, result, unsupported: false };
  }
}

async function pairedExtensionVersion(deps: UpdateDeps): Promise<string | null> {
  try {
    const client = await deps.connect();
    if (client === undefined) return null;
    return (await client.request<StatusResponse>('GET', BRIDGE_PATHS.status)).extension.version;
  } catch {
    return null;
  }
}

export async function updateCommand(
  paths: StatePaths,
  argv: readonly string[],
  deps: UpdateDeps = defaultUpdateDeps(paths),
): Promise<number> {
  const args = parse(argv, { json: { type: 'boolean', summary: 'JSON output' } });
  const cli = await updateCli(deps);
  const serve = await restartServe(deps, cli.serveTarget);
  const page = await refreshPageData(deps);

  // The refresh reports the running version; the pairing only the one it paired with.
  const running = page.result?.extensionVersion;
  const paired = running === undefined ? await pairedExtensionVersion(deps) : null;
  let extension: Step;
  if (running !== undefined) extension = { line: `extension ${running} ✓`, code: EXIT.ok };
  else if (page.unsupported) {
    note(
      'this extension cannot refresh its page data yet: update the Voyager extension in your browser',
    );
    extension = {
      line: `extension ${paired ?? '?'}: update the Voyager extension in your browser`,
      code: EXIT.ok,
    };
  } else
    extension = {
      line: paired === null ? 'extension version unknown' : `extension ${paired}`,
      code: EXIT.ok,
    };

  const steps = [cli, ...(serve ? [serve] : []), page, extension];
  const code = steps.find((step) => step.code !== EXIT.ok)?.code ?? EXIT.ok;
  if (args.options.json === true) {
    printJson({
      ok: code === EXIT.ok,
      cli: cli.json,
      serve: serve?.line ?? null,
      pageData: page.result ?? (page.error === undefined ? null : { error: page.error }),
      extension: {
        version: running ?? paired,
        offersRefresh: page.unsupported ? false : running !== undefined ? true : null,
      },
      summary: steps.map((step) => step.line).join(' · '),
    });
  } else printLine(steps.map((step) => step.line).join(' · '));
  return code;
}
