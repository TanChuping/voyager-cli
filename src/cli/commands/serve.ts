import { readFile } from 'node:fs/promises';

import { connectServe, ensureServe, probeServe } from '../../client/serveClient';
import { startBridgeServer } from '../../server/http';
import { loadConfig } from '../../state/config';
import { ensureHome, type StatePaths } from '../../state/paths';
import { acquireServeLock, isAlive } from '../../state/singleInstance';
import { ensureCliToken } from '../../state/tokens';
import { isErrno, readJsonFile, removeFile, writeJsonAtomic } from '../../util/files';
import { isRecord } from '../../util/isRecord';
import { createLogger } from '../../util/log';
import { CLI_VERSION } from '../../version';
import { parse } from '../args';
import { note, printJson } from '../output';

export async function serveCommand(paths: StatePaths, argv: readonly string[]): Promise<number> {
  const args = parse(argv, {
    foreground: { type: 'boolean', summary: 'run in this terminal' },
    daemon: { type: 'boolean', summary: 'internal: run detached' },
    stop: { type: 'boolean', summary: 'stop the running serve' },
    json: { type: 'boolean', summary: 'JSON output' },
  });
  if (args.options.stop === true) return stopServe(paths);
  if (args.options.foreground === true || args.options.daemon === true) {
    return runServe(paths, args.options.daemon === true);
  }
  const client = await ensureServe(paths);
  const info = await readServeInfo(paths);
  if (args.options.json === true)
    printJson({ running: true, port: client.port, pid: info?.pid ?? null });
  else
    note(`voyager serve is running on 127.0.0.1:${client.port}${info ? ` (pid ${info.pid})` : ''}`);
  return 0;
}

interface ServeInfo {
  readonly pid: number;
  readonly port: number;
}

async function readServeInfo(paths: StatePaths): Promise<ServeInfo | undefined> {
  const raw = await readJsonFile(paths.serveJson);
  if (!isRecord(raw) || typeof raw.pid !== 'number' || typeof raw.port !== 'number')
    return undefined;
  return { pid: raw.pid, port: raw.port };
}

/** Runs the server in this process until SIGINT/SIGTERM. */
export async function runServe(paths: StatePaths, daemon: boolean): Promise<number> {
  await ensureHome(paths);
  const log = createLogger();
  const { port } = await loadConfig(paths);
  const lock = await acquireServeLock(paths);
  if (lock.kind === 'held') {
    // Two auto-starts can race; the loser leaves quietly and the client finds the winner.
    const answering = (await probeServe(port)) !== undefined;
    const message = answering
      ? `voyager serve is already running (pid ${lock.pid})`
      : `serve.lock is held by pid ${lock.pid}; if no serve is running, delete ${paths.lock}`;
    if (daemon) log.info(message);
    else note(message);
    return answering || daemon ? 0 : 1;
  }

  const cliToken = await ensureCliToken(paths);
  let server;
  try {
    server = await startBridgeServer({ paths, port, cliToken, log });
  } catch (error) {
    await lock.release();
    if (isErrno(error, 'EADDRINUSE')) {
      const ours = (await connectServe(paths).catch(() => undefined)) !== undefined;
      const message = ours
        ? 'voyager serve is already running'
        : `port ${port} is in use by another program; set "port" in ${paths.config}`;
      if (daemon) log.error(message);
      else note(message);
      return ours ? 0 : 1;
    }
    throw error;
  }

  await writeJsonAtomic(paths.serveJson, {
    pid: process.pid,
    port: server.port,
    version: CLI_VERSION,
    startedAt: Date.now(),
    serverId: server.core.pairing.serverId,
  });
  if (!daemon) note(`voyager serve listening on 127.0.0.1:${server.port} (Ctrl-C to stop)`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  log.info('serve stopping');
  await server.close();
  const info = await readServeInfo(paths);
  if (info?.pid === process.pid) await removeFile(paths.serveJson);
  await lock.release();
  return 0;
}

async function stopServe(paths: StatePaths): Promise<number> {
  const info = await readServeInfo(paths);
  const pid = info?.pid ?? (await readLockPid(paths));
  if (pid === undefined || !isAlive(pid)) {
    note('voyager serve is not running');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (isAlive(pid)) {
    note(`voyager serve (pid ${pid}) did not stop`);
    return 1;
  }
  note('voyager serve stopped');
  return 0;
}

async function readLockPid(paths: StatePaths): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(paths.lock, 'utf8')).trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
