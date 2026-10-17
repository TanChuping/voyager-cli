import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, readFile } from 'node:fs/promises';

import { isErrno, removeFile } from '../util/files';
import type { StatePaths } from './paths';

export type LockResult =
  | { readonly kind: 'acquired'; release(): Promise<void> }
  | { readonly kind: 'held'; readonly pid: number };

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return isErrno(error, 'EPERM');
  }
}

/**
 * `serve.lock` holds the pid of the one running serve. A lock whose pid is gone
 * is stale and taken over; a live one means another serve owns this home.
 */
export async function acquireServeLock(paths: StatePaths): Promise<LockResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await linkLock(paths)) {
      return {
        kind: 'acquired',
        release: async () => {
          if ((await readLockPid(paths)) === process.pid) await removeFile(paths.lock);
        },
      };
    }
    const pid = await readLockPid(paths);
    if (pid !== undefined && pid !== process.pid && isAlive(pid)) return { kind: 'held', pid };
    await removeFile(paths.lock);
  }
  const pid = await readLockPid(paths);
  return { kind: 'held', pid: pid ?? -1 };
}

/**
 * Write the pid to a private file, then hard-link it into place: the lock never
 * exists without its pid, so a racing serve cannot mistake it for a stale one.
 */
async function linkLock(paths: StatePaths): Promise<boolean> {
  const tmp = `${paths.lock}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${process.pid}\n`);
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, paths.lock);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await removeFile(tmp);
  }
}

async function readLockPid(paths: StatePaths): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(paths.lock, 'utf8')).trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
