import { BRIDGE_HOST, MAX_JSON_BODY_BYTES, POLL_HOLD_MS } from '@voyager-crew/bridge-protocol';
/**
 * `voyager serve`'s HTTP server: node:http on 127.0.0.1 only. Routing, body
 * limits and the guards from §2.4 live here; endpoint logic is in routes/.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BlobStore } from '../jobs/blobStore';
import { JobRunner } from '../jobs/jobRunner';
import { JobStore } from '../jobs/jobStore';
import { TaskSlot } from '../jobs/taskSlot';
import { PluginRegistry } from '../plugins/registry';
import { recordLastConversation } from '../state/lastConversation';
import type { StatePaths } from '../state/paths';
import { BridgeFailure, failure } from '../util/errors';
import { silentLogger, type Logger } from '../util/log';
import { ExtensionState } from './extensionState';
import { checkCli, checkHost, checkOpenOrigin, checkProtocol, header } from './guards';
import { PairingStore } from './pairing';
import { forbidden, HttpFailure, sendError, sendJson, sendOk } from './respond';
import { cliRoutes } from './routes/cli';
import { extRoutes } from './routes/ext';
import { openRoutes } from './routes/open';

export interface BridgeServerOptions {
  readonly paths: StatePaths;
  /** 0 picks a free port (tests). */
  readonly port: number;
  readonly cliToken: string;
  readonly log?: Logger;
  readonly registry?: PluginRegistry;
  readonly now?: () => number;
  readonly pollHoldMs?: number;
  readonly extensionOfflineMs?: number;
  readonly ackDeadlineMs?: number;
  readonly deadlineGraceMs?: number;
  readonly abortResendMs?: number;
}

export type Access = 'open' | 'pair' | 'ext' | 'cli';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: readonly string[];
  readonly body: unknown;
  readonly origin: string | undefined;
}

export interface Reply {
  readonly status: number;
  readonly data?: unknown;
  /** Send `data` as the whole body instead of wrapping it in `{ok:true,data}`. */
  readonly raw?: boolean;
}

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly access: Access;
  handle(ctx: RouteContext): Promise<Reply> | Reply;
}

export interface ServerCore {
  readonly paths: StatePaths;
  readonly log: Logger;
  readonly now: () => number;
  readonly pairing: PairingStore;
  readonly extension: ExtensionState;
  readonly slot: TaskSlot;
  readonly store: JobStore;
  readonly runner: JobRunner;
  readonly registry: PluginRegistry;
  readonly blobs: BlobStore;
  readonly pollHoldMs: number;
  /** Ends a held poll; set while one is held. */
  heldPoll: (() => void) | undefined;
}

export interface BridgeServer {
  readonly port: number;
  readonly core: ServerCore;
  close(): Promise<void>;
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServer> {
  const log = options.log ?? silentLogger;
  const now = options.now ?? Date.now;
  const pairing = new PairingStore(options.paths, now);
  await pairing.load();
  const store = new JobStore(options.paths, now);
  await store.init();
  const slot = new TaskSlot({
    now,
    ...(options.ackDeadlineMs === undefined ? {} : { ackDeadlineMs: options.ackDeadlineMs }),
    ...(options.extensionOfflineMs === undefined
      ? {}
      : { extensionOfflineMs: options.extensionOfflineMs }),
    ...(options.deadlineGraceMs === undefined ? {} : { deadlineGraceMs: options.deadlineGraceMs }),
    ...(options.abortResendMs === undefined ? {} : { abortResendMs: options.abortResendMs }),
  });
  const extension = new ExtensionState();
  const registry = options.registry ?? new PluginRegistry();
  const blobs = new BlobStore(options.paths, (jobId) => store.jobDir(jobId));
  const runner = new JobRunner({
    blobs,
    store,
    slot,
    registry,
    extension,
    isPaired: () => pairing.current !== null,
    log,
    rememberConversation: (entry) => recordLastConversation(options.paths, entry),
  });
  const core: ServerCore = {
    paths: options.paths,
    log,
    now,
    pairing,
    extension,
    slot,
    store,
    runner,
    registry,
    blobs,
    pollHoldMs: options.pollHoldMs ?? POLL_HOLD_MS,
    heldPoll: undefined,
  };
  const routes: Route[] = [...openRoutes(core), ...extRoutes(core), ...cliRoutes(core)];

  let boundPort = options.port;
  const server = createServer((req, res) => {
    handle(req, res).catch((thrown: unknown) => {
      log.error('request failed', { error: String(thrown) });
      sendError(
        res,
        thrown instanceof BridgeFailure ? thrown : failure('bad-request', 'internal error'),
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') throw forbidden('preflight requests are refused');
      checkHost(req, boundPort);
      const url = new URL(req.url ?? '/', `http://${BRIDGE_HOST}:${boundPort}`);
      const match = findRoute(routes, req.method ?? 'GET', url.pathname);
      if (match === undefined)
        throw failure('not-found', `no endpoint ${req.method} ${url.pathname}`);
      const { route, params } = match;

      let origin: string | undefined;
      if (route.access === 'cli') {
        checkCli(req, options.cliToken);
        checkProtocol(req, 'cli');
      } else if (route.access === 'ext') {
        origin = header(req, 'origin');
        checkProtocol(req, 'extension');
      } else {
        origin = checkOpenOrigin(req, route.access === 'pair');
        if (route.access === 'pair') checkProtocol(req, 'extension');
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      const reply = await route.handle({ req, res, url, params, body, origin });
      if (reply.status === 204) sendJson(res, 204, undefined);
      else if (reply.raw) sendJson(res, reply.status, reply.data);
      else sendOk(res, reply.status, reply.data);
    } catch (thrown) {
      if (thrown instanceof BridgeFailure) sendError(res, thrown);
      else throw thrown;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, BRIDGE_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;
  log.info('serve listening', { host: BRIDGE_HOST, port: boundPort });

  return {
    port: boundPort,
    core,
    close: async () => {
      core.heldPoll?.();
      store.releaseWaiters();
      slot.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await runner.settled();
      await store.flush();
    },
  };
}

function findRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: string[] } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1).map((part) => decodeURIComponent(part)) };
  }
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(header(req, 'content-length') ?? 0);
  if (declared > MAX_JSON_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw tooLarge();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failure('bad-request', 'body is not valid JSON');
  }
}

function tooLarge(): HttpFailure {
  return new HttpFailure(
    413,
    failure('bad-request', `JSON bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`).error,
  );
}
