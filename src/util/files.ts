import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** Write through a temporary file and rename, so a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/**
 * Create a new file and refuse to follow a symlink or replace anything that is
 * already there (`wx` + `O_NOFOLLOW`).
 */
export async function writeFileExclusive(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, mode);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
