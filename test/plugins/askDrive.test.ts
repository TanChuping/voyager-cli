import { unzipSync } from 'fflate';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareDrive, type RcloneRunner } from '../../plugins/ask/drive';
import type { ForegroundContext } from '../../src/plugins/api';
import { BridgeFailure } from '../../src/util/errors';

const made: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

let staging: string;
beforeEach(async () => {
  // An empty voyager home: no config.json, so only the environment names a destination.
  vi.stubEnv('VOYAGER_HOME', await tempDir('voyager-home-'));
  staging = await tempDir('voyager-staging-');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

function foreground(cwd: string, notes: string[] = []): ForegroundContext {
  return {
    cwd,
    stagingDir: async () => staging,
    note: (message) => notes.push(message),
    lastConversation: async () => undefined,
  };
}

/** A stand-in rclone: records each call, keeps what `copyto` received, lists it with ids. */
function fakeRclone() {
  const calls: string[][] = [];
  const uploaded = new Map<string, Buffer>();
  const run: RcloneRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'copyto') {
      uploaded.set(args[2]!, await readFile(args[1]!));
      return '';
    }
    const folder = args[2]!;
    return JSON.stringify(
      [...uploaded.keys()]
        .filter((path) => path.startsWith(`${folder}/`))
        .map((path, index) => ({ Name: path.slice(folder.length + 1), ID: `id-${index}` })),
    );
  };
  return { run, calls, uploaded };
}

const env = { VOYAGER_DRIVE_REMOTE: 'gdrive:Voyager' };
const now = new Date('2026-10-19T14:25:01Z');

describe('ask --drive', () => {
  it('uploads into a folder of its own and links each file in the prompt', async () => {
    const cwd = await tempDir('voyager-cwd-');
    await writeFile(join(cwd, 'notes.md'), '# notes\n');
    const rclone = fakeRclone();

    const { block, files } = await prepareDrive(foreground(cwd), ['notes.md'], {
      dryRun: false,
      run: rclone.run,
      env,
      now,
    });

    expect(rclone.calls[0]?.[0]).toBe('copyto');
    expect(rclone.calls[0]?.[2]).toMatch(
      /^gdrive:Voyager\/voyager-20261019-142501-[0-9a-f]{4}\/notes\.md$/,
    );
    expect(files).toEqual([
      expect.objectContaining({
        name: 'notes.md',
        id: 'id-0',
        url: 'https://drive.google.com/file/d/id-0/view',
      }),
    ]);
    expect(block).toContain('Google Drive tool');
    expect(block).toContain('- notes.md: file id id-0');
    // A Drive link becomes a chip in ChatGPT's composer, which composer.send cannot read back.
    expect(block).not.toContain('drive.google.com');
  });

  it('zips a folder without its credentials, and removes the staged copy once uploaded', async () => {
    const cwd = await tempDir('voyager-cwd-');
    await mkdir(join(cwd, 'repo', 'src'), { recursive: true });
    await writeFile(join(cwd, 'repo', 'src', 'main.ts'), 'export {};\n');
    await writeFile(join(cwd, 'repo', '.env'), 'TOKEN=secret\n');
    const rclone = fakeRclone();

    const { block } = await prepareDrive(foreground(cwd), ['repo'], {
      dryRun: false,
      run: rclone.run,
      env,
      now,
    });

    const [zip] = [...rclone.uploaded.values()];
    const entries = Object.keys(unzipSync(new Uint8Array(zip!)));
    expect(entries).toContain('repo/src/main.ts');
    expect(entries.filter((entry) => entry.endsWith('.env'))).toEqual([]);
    expect(block).toContain('repo.zip (a zip of the local folder repo, 1 file)');
    expect(await readdir(staging)).toEqual([]);
  });

  it('uploads nothing on a dry run', async () => {
    const cwd = await tempDir('voyager-cwd-');
    await writeFile(join(cwd, 'notes.md'), '# notes\n');
    const rclone = fakeRclone();

    const { block } = await prepareDrive(foreground(cwd), ['notes.md'], {
      dryRun: true,
      run: rclone.run,
      env,
      now,
    });

    expect(rclone.calls).toEqual([]);
    expect(block).toContain('- notes.md: file id (given on send)');
  });

  it('explains the rclone setup when no destination is configured', async () => {
    const cwd = await tempDir('voyager-cwd-');
    await writeFile(join(cwd, 'notes.md'), '# notes\n');

    const error = await prepareDrive(foreground(cwd), ['notes.md'], {
      dryRun: false,
      run: fakeRclone().run,
      env: {},
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BridgeFailure);
    expect((error as BridgeFailure).message).toMatch(/VOYAGER_DRIVE_REMOTE/);
  });

  it('fails when rclone copies a file but reports no Drive id for it', async () => {
    const cwd = await tempDir('voyager-cwd-');
    await writeFile(join(cwd, 'notes.md'), '# notes\n');
    const run: RcloneRunner = async (args) => (args[0] === 'lsjson' ? '[]' : '');

    await expect(
      prepareDrive(foreground(cwd), ['notes.md'], { dryRun: false, run, env, now }),
    ).rejects.toThrow(/no Drive id/);
  });
});
