import { type AsyncFlateStreamHandler, Zip, type ZipInputFile } from 'fflate';
/**
 * Pack listed files into a zip: fflate writes the archive, Node's zlib
 * deflates each file (level 6). One source file is read at a time; the
 * archive itself (at most `maxBytes`) is written once complete. Entries are
 * sorted and carry a fixed mtime, so the same files give the same bytes and
 * the same sha256. Stops as soon as the archive outgrows `maxBytes`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

import { failure } from '../errors';
import { writeFileExclusive } from '../files';
import type { ListedFile } from './listFolder';
import { checkEntryPath } from './listFolder';

/** DOS time starts in 1980; any fixed date keeps the archive reproducible. */
const FIXED_MTIME = new Date(2000, 0, 1, 0, 0, 0);
const LEVEL = 6;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A zip entry whose deflated bytes are ready. fflate's own streaming
 * `ZipDeflate` (0.8.2 and 0.8.3) can emit an invalid stream ("invalid distance
 * too far back") for a file that follows a large one, so it is not used.
 */
class DeflatedEntry implements ZipInputFile {
  readonly compression = 8;
  readonly mtime = FIXED_MTIME;
  ondata?: AsyncFlateStreamHandler;

  constructor(
    readonly filename: string,
    readonly size: number,
    readonly crc: number,
    private readonly deflated: Uint8Array,
  ) {}

  emit(): void {
    this.ondata?.(null, this.deflated, true);
  }
}

export interface ZipResult {
  readonly size: number;
  readonly sha256: string;
  readonly entries: number;
}

/** Sizes summed per top-level folder, largest first; for the "too large" message. */
export function largestFolders(
  files: readonly ListedFile[],
  count = 5,
): { path: string; bytes: number }[] {
  const totals = new Map<string, number>();
  for (const file of files) {
    const top = file.relative.includes('/') ? `${file.relative.split('/')[0]}/` : file.relative;
    totals.set(top, (totals.get(top) ?? 0) + file.size);
  }
  return [...totals]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Write `files` under `root/` inside a new zip at `outPath` (which must not
 * exist). Throws `bad-request` naming the largest folders, and writes
 * nothing, when the zip would exceed `maxBytes`.
 */
export async function zipFiles(
  files: readonly ListedFile[],
  root: string,
  outPath: string,
  maxBytes: number,
): Promise<ZipResult> {
  const parts: Uint8Array[] = [];
  const hash = createHash('sha256');
  let size = 0;
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) {
      zipError = error;
      return;
    }
    size += chunk.length;
    if (size <= maxBytes) {
      hash.update(chunk);
      parts.push(chunk.slice());
    }
  });
  const tooLarge = () =>
    failure(
      'bad-request',
      `the zip of ${root} is over ${formatBytes(maxBytes)}; the largest folders are ${largestFolders(
        files,
      )
        .map((entry) => `${entry.path} (${formatBytes(entry.bytes)})`)
        .join(', ')}`,
      { limit: maxBytes, largest: largestFolders(files) },
    );

  const sorted = [...files].sort((a, b) => (a.relative < b.relative ? -1 : 1));
  for (const file of sorted) {
    const data = await readFile(file.absolute);
    const entry = new DeflatedEntry(
      `${root}/${checkEntryPath(file.relative)}`,
      data.length,
      crc32(data),
      deflateRawSync(data, { level: LEVEL }),
    );
    zip.add(entry);
    entry.emit();
    if (zipError) throw zipError;
    if (size > maxBytes) {
      zip.terminate();
      throw tooLarge();
    }
  }
  zip.end();
  if (zipError) throw zipError;
  if (size > maxBytes) throw tooLarge();

  await writeFileExclusive(outPath, Buffer.concat(parts));
  return { size, sha256: hash.digest('hex'), entries: sorted.length };
}
