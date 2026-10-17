import { chmod, readFile } from 'node:fs/promises';

import { isErrno, writeFileExclusive } from '../util/files';
import { newToken } from '../util/hash';
import type { StatePaths } from './paths';

/** The CLI token in `cli-token` (0600); serve creates it on first start. */
export async function ensureCliToken(paths: StatePaths): Promise<string> {
  const existing = await readCliToken(paths);
  if (existing !== undefined) {
    await chmod(paths.cliToken, 0o600);
    return existing;
  }
  const token = newToken();
  try {
    await writeFileExclusive(paths.cliToken, `${token}\n`, 0o600);
    return token;
  } catch (error) {
    // Another serve won the race; use its token.
    if (isErrno(error, 'EEXIST')) {
      const raced = await readCliToken(paths);
      if (raced !== undefined) return raced;
    }
    throw error;
  }
}

export async function readCliToken(paths: StatePaths): Promise<string | undefined> {
  try {
    const token = (await readFile(paths.cliToken, 'utf8')).trim();
    return token === '' ? undefined : token;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
