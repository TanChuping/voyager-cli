import { unzipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkEntryPath } from '../../src/util/attach/listFolder';
import { stageAttachments, type StagedAttachment } from '../../src/util/attach/stage';
import { BridgeFailure } from '../../src/util/errors';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function tree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  }
}

async function stage(paths: string[], maxBytes?: number) {
  const staging = await tempDir('voyager-staging-');
  const notes: string[] = [];
  const staged = await stageAttachments(paths, {
    cwd: '/',
    stagingDir: async () => staging,
    note: (message) => notes.push(message),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { staged, notes };
}

async function entries(attachment: StagedAttachment): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await readFile(attachment.path)));
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof BridgeFailure ? error.code : String(error);
  }
  return undefined;
}

/** Bytes that do not compress, so a small size limit is reached quickly. */
function noise(size: number, seed: number): Uint8Array {
  let state = seed;
  return Uint8Array.from({ length: size }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 24;
  });
}

describe('attach: folders', () => {
  it('zips a plain folder without credentials, dependencies or build output', async () => {
    const root = join(await tempDir('voyager-src-'), 'proj');
    const source = 'export const answer = 42;\n';
    await tree(root, {
      'README.md': '# proj\n',
      'src/a.ts': source,
      'assets/logo.bin': noise(4096, 3),
      '.env': 'TOKEN=1',
      '.env.local': 'TOKEN=2',
      'config/server.pem': 'key',
      id_rsa: 'key',
      '.npmrc': '//registry/:_authToken=x',
      '.ssh/config': 'Host x',
      'node_modules/dep/index.js': 'x',
      'dist/out.js': 'x',
      'build/b.js': 'x',
      '.next/cache.json': 'x',
    });
    await symlink(join(root, 'src/a.ts'), join(root, 'link.ts'));

    const { staged, notes } = await stage([root]);
    expect(staged).toHaveLength(1);
    const [zip] = staged;
    expect(zip).toMatchObject({
      name: 'proj.zip',
      mime: 'application/zip',
      kind: 'folder',
      listing: 'walk',
      fileCount: 3,
      leftOut: { sensitive: 6 },
    });
    const files = await entries(zip);
    expect(Object.keys(files).sort()).toEqual([
      'proj/README.md',
      'proj/assets/logo.bin',
      'proj/src/a.ts',
    ]);
    expect(Buffer.from(files['proj/src/a.ts']).toString()).toBe(source);
    expect(Buffer.from(files['proj/assets/logo.bin'])).toEqual(Buffer.from(noise(4096, 3)));
    const bytes = await readFile(zip.path);
    expect(zip.size).toBe(bytes.length);
    expect(zip.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(notes.join('\n')).toMatch(/left out 6 credential file\(s\)/);
    expect(notes.join('\n')).not.toMatch(/TOKEN/);
  });

  it('follows .gitignore in a git work tree and still leaves committed credentials out', async () => {
    const root = join(await tempDir('voyager-git-'), 'repo');
    await tree(root, {
      '.gitignore': 'ignored.txt\nout/\n',
      'tracked.ts': 'a',
      'untracked.ts': 'b',
      'ignored.txt': 'c',
      'out/bundle.js': 'd',
      '.env.production': 'TOKEN=3',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'tracked.ts', '.gitignore'], { cwd: root });
    execFileSync('git', ['add', '-f', '.env.production'], { cwd: root });

    const { staged } = await stage([root]);
    expect(staged[0]).toMatchObject({ listing: 'git', leftOut: { sensitive: 1 } });
    expect(Object.keys(await entries(staged[0])).sort()).toEqual([
      'repo/.gitignore',
      'repo/tracked.ts',
      'repo/untracked.ts',
    ]);
  });

  it('packs the same files to the same bytes', async () => {
    const root = join(await tempDir('voyager-same-'), 'proj');
    await tree(root, { 'b.txt': 'b', 'a/c.txt': 'c', 'a.txt': 'a' });
    const first = await stage([root]);
    const second = await stage([root]);
    expect(second.staged[0].sha256).toBe(first.staged[0].sha256);
  });

  it('refuses a zip over the limit and names the largest folders', async () => {
    const root = join(await tempDir('voyager-big-'), 'proj');
    await tree(root, { 'big/blob.bin': noise(64 * 1024, 1), 'small/a.txt': 'a' });
    let caught: unknown;
    try {
      await stage([root], 16 * 1024);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BridgeFailure);
    const failure = caught as BridgeFailure;
    expect(failure.code).toBe('bad-request');
    expect(failure.message).toContain('big/');
    expect(failure.error.details?.largest).toEqual([
      { path: 'big/', bytes: 65536 },
      { path: 'small/', bytes: 1 },
    ]);
  });
});

describe('attach: files', () => {
  it('copies a file as it is, under its own name and type', async () => {
    const dir = await tempDir('voyager-file-');
    await tree(dir, { 'report.pdf': '%PDF-1.7' });
    const { staged } = await stage([join(dir, 'report.pdf')]);
    expect(staged[0]).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', kind: 'file' });
    expect(await readFile(staged[0].path, 'utf8')).toBe('%PDF-1.7');
  });

  it('never uploads a file that looks like a credential, even when named', async () => {
    const dir = await tempDir('voyager-cred-');
    await tree(dir, { '.env': 'TOKEN=1', 'deploy.key': 'k' });
    expect(await codeOf(stage([join(dir, '.env')]))).toBe('bad-request');
    expect(await codeOf(stage([join(dir, 'deploy.key')]))).toBe('bad-request');
  });

  it('gives two attachments with one name distinct names', async () => {
    const dir = await tempDir('voyager-dup-');
    await tree(dir, { 'a/notes.md': '1', 'b/notes.md': '2' });
    const { staged } = await stage([join(dir, 'a/notes.md'), join(dir, 'b/notes.md')]);
    expect(staged.map((entry) => entry.name)).toEqual(['notes.md', 'notes-2.md']);
  });
});

describe('attach: entry paths', () => {
  it.each(['../x', 'a/../b', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', ''])(
    'refuses %j as a zip entry',
    (path) => {
      let code: string | undefined;
      try {
        checkEntryPath(path);
      } catch (error) {
        code = error instanceof BridgeFailure ? error.code : undefined;
      }
      expect(code).toBe('path-unsafe');
    },
  );
});
