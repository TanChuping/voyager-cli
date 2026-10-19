/**
 * `ask --drive <path>`: put files on Google Drive with rclone and give ChatGPT
 * their links, for its Google Drive app to read, instead of uploading them
 * through the page. Packing is `--attach`'s (`stageAttachments`: folders zipped
 * without credentials), but the bridge's relay limit does not apply: ChatGPT's
 * own per-file limit does.
 *
 * Each ask gets its own folder under the configured rclone destination
 * (`$VOYAGER_DRIVE_REMOTE`, else `driveRemote` in `config.json`). ChatGPT reads
 * the files as the person, so nothing is shared publicly (`rclone link` would
 * make the file public).
 *
 * The prompt names each file by its Drive id, not its link: ChatGPT's composer
 * turns a Drive link into a chip whose icon carries CSS text, and Voyager
 * extensions up to 2.1.1 read that CSS back as typed text, so `composer.send`
 * refuses with `composer-busy` (`recent-input`).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ForegroundContext } from '../../src/plugins/api';
import { loadConfig } from '../../src/state/config';
import { statePaths } from '../../src/state/paths';
import { type StagedAttachment, stageAttachments } from '../../src/util/attach/stage';
import { failure } from '../../src/util/errors';
import { isRecord } from '../../src/util/isRecord';

/** ChatGPT's limit for one file. */
export const DRIVE_MAX_BYTES = 512 * 1024 * 1024;

const SETUP =
  'set up an rclone remote for Google Drive (`rclone config`), then set VOYAGER_DRIVE_REMOTE ' +
  '(or "driveRemote" in ~/.voyager/config.json) to a folder on it, such as gdrive:Voyager. ' +
  "ChatGPT's Google Drive app must be connected to the same Google account";

/** Runs `rclone <args>` and returns its stdout. */
export type RcloneRunner = (args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runRclone: RcloneRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync('rclone', [...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw failure('bad-request', `--drive needs rclone, which is not installed: ${SETUP}`);
    }
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const last = stderr.split('\n').slice(-3).join(' ') || String(error);
    throw failure('bad-request', `rclone ${args[0]} failed: ${last}`);
  }
};

export interface DriveFile {
  readonly name: string;
  readonly size: number;
  readonly id: string;
  readonly url: string;
  readonly kind: 'file' | 'folder';
  readonly source: string;
  readonly fileCount?: number;
}

/** The rclone destination: the environment first, then `config.json`. */
export async function driveRemote(
  env: NodeJS.ProcessEnv = process.env,
  configured?: string,
): Promise<string> {
  const remote = (env.VOYAGER_DRIVE_REMOTE ?? '').trim() || configured;
  if (remote === undefined || remote === '') {
    throw failure('bad-request', `--drive has no destination: ${SETUP}`);
  }
  if (!remote.includes(':')) {
    throw failure(
      'bad-request',
      `the Drive destination ${JSON.stringify(remote)} is not an rclone remote path (remote:folder)`,
    );
  }
  return remote;
}

export function remotePath(remote: string, ...parts: readonly string[]): string {
  const joined = parts.join('/');
  return remote.endsWith(':') || remote.endsWith('/')
    ? `${remote}${joined}`
    : `${remote}/${joined}`;
}

/** One folder per ask, sortable by time: `voyager-20261019-142501-3fa9`. */
export function uploadFolderName(now: Date, random = randomBytes(2).toString('hex')): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `voyager-${stamp}-${random}`;
}

export function driveFileUrl(id: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

/** Copies each staged file into `folder` on `remote`, then reads back their Drive ids. */
export async function uploadToDrive(
  staged: readonly StagedAttachment[],
  options: { readonly remote: string; readonly folder: string; readonly run?: RcloneRunner },
): Promise<DriveFile[]> {
  const run = options.run ?? runRclone;
  for (const file of staged) {
    await run(['copyto', file.path, remotePath(options.remote, options.folder, file.name)]);
  }
  const listed: unknown = JSON.parse(
    await run(['lsjson', '--files-only', remotePath(options.remote, options.folder)]),
  );
  const ids = new Map<string, string>();
  for (const entry of Array.isArray(listed) ? listed : []) {
    if (isRecord(entry) && typeof entry.Name === 'string' && typeof entry.ID === 'string') {
      ids.set(entry.Name, entry.ID);
    }
  }
  return staged.map((file) => {
    const id = ids.get(file.name);
    if (id === undefined) {
      throw failure(
        'bad-request',
        `${file.name} was copied but rclone reports no Drive id for it; is ${options.remote} a Google Drive remote?`,
      );
    }
    return {
      name: file.name,
      size: file.size,
      id,
      url: driveFileUrl(id),
      kind: file.kind,
      source: file.source,
      ...(file.fileCount === undefined ? {} : { fileCount: file.fileCount }),
    };
  });
}

/** The lines the prompt gets: which tool to use, and one link per file. */
export function drivePromptBlock(
  files: readonly Pick<DriveFile, 'name' | 'id' | 'kind' | 'source' | 'fileCount'>[],
): string {
  const lines = files.map((file) => {
    const zip =
      file.kind === 'folder'
        ? ` (a zip of the local folder ${basename(file.source)}, ${file.fileCount ?? 0} file${file.fileCount === 1 ? '' : 's'})`
        : '';
    return `- ${file.name}${zip}: file id ${file.id}`;
  });
  return [
    'Files on Google Drive: fetch each one by its file id with the Google Drive tool (download a zip and open it).',
    ...lines,
  ].join('\n');
}

/**
 * The `--drive` half of `prepare`: pack, upload (unless `dryRun`), and return
 * the prompt block. Staged copies are removed once they are on Drive.
 */
export async function prepareDrive(
  fg: ForegroundContext,
  paths: readonly string[],
  options: {
    readonly dryRun: boolean;
    readonly run?: RcloneRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: Date;
  },
): Promise<{ readonly block: string; readonly files: readonly DriveFile[] }> {
  if (paths.length === 0) return { block: '', files: [] };
  const configured = (await loadConfig(statePaths())).driveRemote;
  const remote = await driveRemote(options.env, configured);
  // Its own folder: `--attach` stages into the same command folder and may pick the same names.
  const stagingDir = async (): Promise<string> => {
    const dir = join(await fg.stagingDir(), 'drive');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const staged = await stageAttachments(paths, {
    cwd: fg.cwd,
    stagingDir,
    note: fg.note,
    maxBytes: DRIVE_MAX_BYTES,
  });
  const folder = uploadFolderName(options.now ?? new Date());
  if (options.dryRun) {
    const planned = staged.map((file) => ({ ...file, id: '(given on send)' }));
    fg.note(`drive: would upload to ${remotePath(remote, folder)}`);
    return { block: drivePromptBlock(planned), files: [] };
  }
  fg.note(`drive: uploading ${staged.length} file(s) to ${remotePath(remote, folder)}`);
  const files = await uploadToDrive(staged, {
    remote,
    folder,
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  for (const file of staged) await rm(file.path, { force: true });
  const dir = staged[0] === undefined ? undefined : dirname(staged[0].path);
  if (dir !== undefined) await rmdir(dir).catch(() => undefined);
  return { block: drivePromptBlock(files), files };
}
