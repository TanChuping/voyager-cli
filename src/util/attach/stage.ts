import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '@voyager-crew/bridge-protocol';
/**
 * The foreground half of `--attach`: turn each path into one upload file in a
 * staging folder, before any job exists. A file is copied as it is; a folder
 * becomes `<folder>.zip` (see `listFolder` for what goes in). Serve later
 * checks each staged file again and moves it into the job (`BlobStore`).
 */
import { createHash } from 'node:crypto';
import { copyFile, constants, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { failure } from '../errors';
import { mimeFor } from '../mime';
import { sanitizeFileName, uniqueName } from '../sanitizeName';
import { listFolder } from './listFolder';
import { isSensitivePath } from './sensitive';
import { formatBytes, zipFiles } from './zipFolder';

export interface StagedAttachment {
  /** Inside the staging folder; serve refuses any other place. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly mime: string;
  readonly kind: 'file' | 'folder';
  /** The path as given, resolved. */
  readonly source: string;
  /** Folders: files packed, and how they were chosen. */
  readonly fileCount?: number;
  readonly listing?: 'git' | 'walk';
  /** Folders: credential files left out (count, and up to five paths). */
  readonly leftOut?: { readonly sensitive: number; readonly examples: readonly string[] };
}

export interface StageOptions {
  readonly cwd: string;
  /** A fresh staging folder for this command; created on first use. */
  readonly stagingDir: () => Promise<string>;
  readonly note: (message: string) => void;
  /** Per upload; the bridge's limit unless a caller that skips the bridge (Drive) passes its own. */
  readonly maxBytes?: number;
}

const EXAMPLES = 5;

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function stageFolder(
  source: string,
  taken: Set<string>,
  options: StageOptions,
  maxBytes: number,
): Promise<StagedAttachment> {
  const folder = await realpath(source);
  const listing = await listFolder(folder);
  if (listing.files.length === 0) {
    throw failure('bad-request', `${source} has no files to attach`);
  }
  const root = sanitizeFileName(basename(folder), 'folder');
  const name = uniqueName(`${root}.zip`, taken);
  const path = join(await options.stagingDir(), name);
  const zipped = await zipFiles(listing.files, root, path, maxBytes);
  const raw = listing.files.reduce((sum, file) => sum + file.size, 0);
  const examples = listing.sensitive.slice(0, EXAMPLES);
  options.note(
    `attach: ${source} → ${name}: ${zipped.entries} files, ${formatBytes(zipped.size)} zipped ` +
      `(${formatBytes(raw)} raw), chosen by ${listing.source === 'git' ? 'git ls-files' : 'folder walk'}`,
  );
  if (listing.sensitive.length > 0) {
    options.note(
      `attach: left out ${listing.sensitive.length} credential file(s), e.g. ${examples.join(', ')}`,
    );
  }
  if (listing.tooLarge.length > 0) {
    options.note(
      `attach: left out ${listing.tooLarge.length} file(s) over 20 MiB, e.g. ${listing.tooLarge
        .slice(0, EXAMPLES)
        .join(', ')}`,
    );
  }
  if (listing.symlinks > 0) options.note(`attach: skipped ${listing.symlinks} symlink(s)`);
  return {
    path,
    name,
    size: zipped.size,
    sha256: zipped.sha256,
    mime: 'application/zip',
    kind: 'folder',
    source,
    fileCount: zipped.entries,
    listing: listing.source,
    leftOut: { sensitive: listing.sensitive.length, examples },
  };
}

async function stageFile(
  source: string,
  size: number,
  taken: Set<string>,
  options: StageOptions,
  maxBytes: number,
): Promise<StagedAttachment> {
  if (isSensitivePath(basename(source))) {
    throw failure('bad-request', `${source} looks like a credential file; it is never uploaded`);
  }
  if (size === 0) throw failure('bad-request', `${source} is empty`);
  if (size > maxBytes) {
    throw failure(
      'bad-request',
      `${source} is ${formatBytes(size)}; uploads are limited to ${formatBytes(maxBytes)}`,
      { size, limit: maxBytes },
    );
  }
  const name = uniqueName(sanitizeFileName(basename(source)), taken);
  const path = join(await options.stagingDir(), name);
  await copyFile(source, path, constants.COPYFILE_EXCL);
  const copied = await stat(path);
  if (copied.size !== size) throw failure('bad-request', `${source} changed while it was copied`);
  options.note(`attach: ${source} → ${name} (${formatBytes(size)})`);
  return {
    path,
    name,
    size,
    sha256: await sha256File(path),
    mime: mimeFor(name),
    kind: 'file',
    source,
  };
}

export async function stageAttachments(
  inputs: readonly string[],
  options: StageOptions,
): Promise<StagedAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw failure('bad-request', `at most ${MAX_ATTACHMENTS} attachments per message`);
  }
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const taken = new Set<string>();
  const staged: StagedAttachment[] = [];
  for (const input of inputs) {
    const source = resolve(options.cwd, input);
    let stats;
    try {
      stats = await stat(source);
    } catch {
      throw failure('bad-request', `cannot read ${input}`);
    }
    const attachment = stats.isDirectory()
      ? await stageFolder(source, taken, options, maxBytes)
      : stats.isFile()
        ? await stageFile(source, stats.size, taken, options, maxBytes)
        : null;
    if (attachment === null) throw failure('bad-request', `${input} is not a file or folder`);
    taken.add(attachment.name.toLowerCase());
    staged.push(attachment);
  }
  return staged;
}
