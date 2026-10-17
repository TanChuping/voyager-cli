/**
 * Bundle the CLI into one ESM file: `bun build.ts [outdir]`. The protocol
 * package (TypeScript source) is inlined, so the published CLI has no runtime
 * dependencies.
 */
import { chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outdir = resolve(process.argv[2] ?? join(import.meta.dir, 'dist'));

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, 'src/cli/main.ts')],
  outdir,
  naming: 'cli.mjs',
  target: 'node',
  format: 'esm',
  banner: '#!/usr/bin/env node',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync(join(outdir, 'cli.mjs'), 0o755);
