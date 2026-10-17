import { PROTOCOL_HEADER } from '@voyager-crew/bridge-protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startBridgeServer,
  type BridgeServer,
  type BridgeServerOptions,
} from '../../src/server/http';
import { ensureHome, statePaths, type StatePaths } from '../../src/state/paths';
import { ensureCliToken } from '../../src/state/tokens';
import { rawRequest, type RawResponse } from './http';

export interface TestServer {
  readonly server: BridgeServer;
  readonly port: number;
  readonly paths: StatePaths;
  readonly cliToken: string;
  cli(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RawResponse>;
  /** Stop and start again on the same state directory (a serve restart). */
  restart(overrides?: Partial<BridgeServerOptions>): Promise<TestServer>;
  close(): Promise<void>;
}

export async function tempHome(): Promise<StatePaths> {
  const paths = statePaths(await mkdtemp(join(tmpdir(), 'voyager-test-')));
  await ensureHome(paths);
  return paths;
}

export async function startTestServer(
  overrides: Partial<BridgeServerOptions> = {},
  existing?: StatePaths,
): Promise<TestServer> {
  const paths = existing ?? (await tempHome());
  const cliToken = await ensureCliToken(paths);
  const server = await startBridgeServer({
    paths,
    port: 0,
    cliToken,
    pollHoldMs: 300,
    extensionOfflineMs: 5_000,
    ...overrides,
  });
  return {
    server,
    port: server.port,
    paths,
    cliToken,
    cli: (method, path, body) =>
      rawRequest({
        port: server.port,
        method,
        path,
        body,
        headers: { authorization: `Bearer ${cliToken}`, [PROTOCOL_HEADER]: '1' },
      }),
    restart: async (next = {}) => {
      await server.close();
      return startTestServer({ ...overrides, ...next }, paths);
    },
    close: async () => {
      await server.close();
      await rm(paths.home, { recursive: true, force: true });
    },
  };
}

export function data<T>(response: RawResponse): T {
  const body = response.json as { ok: boolean; data?: T; error?: unknown };
  if (!body.ok) throw new Error(`expected ok, got ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}

export function errorCode(response: RawResponse): string | undefined {
  return (response.json as { error?: { code?: string } } | undefined)?.error?.code;
}

export function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      if (await check()) return resolve();
      if (Date.now() > deadline) return reject(new Error('condition not met in time'));
      setTimeout(() => void tick(), 20);
    };
    void tick();
  });
}
