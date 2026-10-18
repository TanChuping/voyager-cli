/**
 * Which files of a folder go into its upload zip. A git work tree lists what
 * git would track (`ls-files --cached --others --exclude-standard`), so its
 * own .gitignore decides; any other folder skips VCS, dependency, build and
 * cache folders. Either way, credentials ({@link isSensitivePath}), symlinks,
 * non-regular files and files over {@link MAX_FILE_BYTES} are left out and
 * reported.
 */
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { failure } from '../errors';
import { isSensitivePath } from './sensitive';

const run = promisify(execFile);

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FOLDER_FILES = 5_000;

/** Folder names skipped outside git: VCS, dependencies, build output, caches. */
const SKIPPED_DIRS: readonly RegExp[] = [
  /^\.(?:git|hg|svn)$/,
  /^node_modules$/,
  /^(?:dist|dist[-_.].*|build|out|\.output|coverage|target|DerivedData)$/,
  /^\.(?:next|nuxt|svelte-kit|turbo|cache|parcel-cache|vite|gradle|build|tox|venv)$/,
  /^(?:venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|tmp|\.tmp)$/,
];
const SKIPPED_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

export interface ListedFile {
  /** `/`-separated, relative to the folder; checked by {@link checkEntryPath}. */
  readonly relative: string;
  readonly absolute: string;
  readonly size: number;
}

export interface FolderListing {
  readonly source: 'git' | 'walk';
  readonly files: readonly ListedFile[];
  /** Credentials left out, by relative path. */
  readonly sensitive: readonly string[];
  readonly tooLarge: readonly string[];
  readonly symlinks: number;
}

/** A zip entry path must stay inside the archive: relative, `/`-separated, no `..`. */
export function checkEntryPath(relative: string): string {
  const unsafe =
    relative === '' ||
    relative.startsWith('/') ||
    /^[A-Za-z]:/.test(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (unsafe) throw failure('path-unsafe', `refusing to pack the path ${JSON.stringify(relative)}`);
  return relative;
}

async function isGitWorkTree(folder: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function gitFiles(folder: string): Promise<string[]> {
  const { stdout } = await run(
    'git',
    ['-C', folder, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // A path git lists twice (a merge conflict's stages) is one file.
  return [...new Set(stdout.split('\0').filter((entry) => entry !== ''))];
}

async function walkFiles(folder: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(folder, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.some((pattern) => pattern.test(entry.name))) continue;
      found.push(...(await walkFiles(folder, relative)));
    } else if (!SKIPPED_FILES.has(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

export async function listFolder(folder: string): Promise<FolderListing> {
  const source = (await isGitWorkTree(folder)) ? 'git' : 'walk';
  const candidates = source === 'git' ? await gitFiles(folder) : await walkFiles(folder);
  const files: ListedFile[] = [];
  const sensitive: string[] = [];
  const tooLarge: string[] = [];
  let symlinks = 0;
  for (const relative of candidates.sort()) {
    checkEntryPath(relative);
    if (isSensitivePath(relative)) {
      sensitive.push(relative);
      continue;
    }
    const absolute = join(folder, relative);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      continue; // listed by git, deleted from the work tree
    }
    if (stats.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    if (!stats.isFile()) continue; // submodules, sockets, devices
    if (stats.size > MAX_FILE_BYTES) {
      tooLarge.push(relative);
      continue;
    }
    files.push({ relative, absolute, size: stats.size });
    if (files.length > MAX_FOLDER_FILES) {
      throw failure(
        'bad-request',
        `${folder} has more than ${MAX_FOLDER_FILES} files to pack; attach a smaller folder`,
      );
    }
  }
  return { source, files, sensitive, tooLarge, symlinks };
}
