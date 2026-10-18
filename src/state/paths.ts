import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything `voyager` keeps on disk, under `~/.voyager` or `$VOYAGER_HOME` (spec §4.3). */
export interface StatePaths {
  readonly home: string;
  readonly config: string;
  readonly serveJson: string;
  readonly lock: string;
  readonly cliToken: string;
  readonly pairings: string;
  readonly jobs: string;
  /** Attachments a foreground command packed before its job existed; serve moves them out. */
  readonly staging: string;
  readonly logs: string;
  readonly serveLog: string;
}

export function statePaths(home = defaultHome()): StatePaths {
  return {
    home,
    config: join(home, 'config.json'),
    serveJson: join(home, 'serve.json'),
    lock: join(home, 'serve.lock'),
    cliToken: join(home, 'cli-token'),
    pairings: join(home, 'pairings.json'),
    jobs: join(home, 'jobs'),
    staging: join(home, 'staging'),
    logs: join(home, 'logs'),
    serveLog: join(home, 'logs', 'serve.log'),
  };
}

export function defaultHome(): string {
  const override = process.env.VOYAGER_HOME;
  return override !== undefined && override !== '' ? override : join(homedir(), '.voyager');
}

/** The state directory is private to the user (0700). */
export async function ensureHome(paths: StatePaths): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await mkdir(paths.jobs, { recursive: true, mode: 0o700 });
  await mkdir(paths.staging, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
}
