import {
  BRIDGE_HOST,
  BRIDGE_PATHS,
  envelopeReader,
  PROTOCOL,
  PROTOCOL_HEADER,
  validateMessage,
  validateWith,
  type HelloRequest,
} from '@voyager-crew/bridge-protocol';
/**
 * The foreground side: talk to `voyager serve` with the CLI token, starting it
 * first when nothing answers (spec §4.3 auto-start). Node's fetch sends no
 * Origin, which the CLI endpoints require.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

import { loadConfig } from '../state/config';
import { ensureHome, type StatePaths } from '../state/paths';
import { readCliToken } from '../state/tokens';
import { BridgeFailure, failure } from '../util/errors';
import { readJsonFile } from '../util/files';
import { isRecord } from '../util/isRecord';
import { CLI_VERSION } from '../version';

const START_TIMEOUT_MS = 5_000;

export interface RequestOptions {
  readonly timeoutMs?: number;
}

export class ServeClient {
  constructor(
    readonly port: number,
    private readonly token: string,
  ) {}

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`http://${BRIDGE_HOST}:${this.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          [PROTOCOL_HEADER]: String(PROTOCOL.max),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw failure('timeout', `voyager serve did not answer ${method} ${path} in time`);
      }
      throw failure('server-unreachable', `cannot reach voyager serve on port ${this.port}`);
    }
    if (response.status === 204) return undefined as T;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw failure('server-unreachable', `port ${this.port} did not answer like voyager serve`);
    }
    const envelope = validateWith(
      envelopeReader((raw) => raw),
      json,
    );
    if (!envelope.ok)
      throw failure('server-unreachable', `port ${this.port} did not answer like voyager serve`);
    if (!envelope.value.ok) throw new BridgeFailure(envelope.value.error);
    return envelope.value.data as T;
  }
}

/** `POST /v1/hello` without a token: the serverId of whatever answers on `port`. */
export async function probeServe(port: number): Promise<string | undefined> {
  const hello: HelloRequest = { client: 'cli', version: CLI_VERSION, protocol: PROTOCOL };
  try {
    const response = await fetch(`http://${BRIDGE_HOST}:${port}${BRIDGE_PATHS.hello}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hello),
      signal: AbortSignal.timeout(2_000),
    });
    const json = (await response.json()) as unknown;
    if (!isRecord(json) || json.ok !== true) return undefined;
    const checked = validateMessage('helloResponse', json.data);
    return checked.ok ? checked.value.serverId : undefined;
  } catch {
    return undefined;
  }
}

async function ownServerId(paths: StatePaths): Promise<string | undefined> {
  const raw = await readJsonFile(paths.pairings);
  return isRecord(raw) && typeof raw.serverId === 'string' ? raw.serverId : undefined;
}

/** A client for the serve that owns `paths`, or undefined when none is running. */
export async function connectServe(paths: StatePaths): Promise<ServeClient | undefined> {
  const { port } = await loadConfig(paths);
  const serverId = await probeServe(port);
  if (serverId === undefined) return undefined;
  if (serverId !== (await ownServerId(paths))) {
    throw failure(
      'server-unreachable',
      `port ${port} belongs to a voyager serve with another state directory; set "port" in ${paths.config}`,
    );
  }
  const token = await readCliToken(paths);
  if (token === undefined) throw failure('server-unreachable', `no CLI token in ${paths.cliToken}`);
  return new ServeClient(port, token);
}

/**
 * Connect, starting `voyager serve --daemon` detached if nothing answers. Works
 * from the bundled `dist/cli.mjs` and from `bun src/cli/main.ts` alike.
 */
export async function ensureServe(paths: StatePaths): Promise<ServeClient> {
  const running = await connectServe(paths);
  if (running !== undefined) return running;

  await ensureHome(paths);
  const entry = process.argv[1];
  if (entry === undefined)
    throw failure('server-unreachable', 'cannot locate the voyager entry point');
  const log = openSync(paths.serveLog, 'a', 0o600);
  let exited = false;
  try {
    const child = spawn(process.execPath, [entry, 'serve', '--daemon'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.once('exit', () => {
      exited = true;
    });
    child.unref();
  } finally {
    closeSync(log);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const client = await connectServe(paths);
    if (client !== undefined) return client;
    // Another serve may have won the lock and still be starting; keep waiting for it.
    if (exited && Date.now() > deadline - 1_000) break;
  }
  throw failure('server-unreachable', `voyager serve did not start; see ${paths.serveLog}`);
}
