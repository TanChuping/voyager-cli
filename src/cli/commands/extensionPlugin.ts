/**
 * `voyager plugin …`: write a Voyager extension plugin (a page feature for
 * ChatGPT, Gemini, …), not a voyager-cli command. The scaffold and its checks
 * ship with the extension's plugin format as `create-voyager-plugin`, so this
 * runs that package rather than carrying a copy that could fall behind it.
 */
import { spawn } from 'node:child_process';

import { note } from '../output';

const PACKAGE = 'create-voyager-plugin@latest';

const PLUGIN_USAGE = `usage:
  voyager plugin create <dir> [--site <site>]   scaffold an extension plugin
  voyager plugin check <dir>                    run the extension's import checks offline
  voyager plugin <create-voyager-plugin args>   anything else goes to create-voyager-plugin`;

/** The npx arguments for `voyager plugin <argv>`; `create` is the scaffold's `init`. */
export function scaffoldArgs(argv: readonly string[]): string[] {
  const [first, ...rest] = argv;
  const forwarded = first === 'create' ? ['init', ...rest] : [...argv];
  return ['--yes', PACKAGE, ...forwarded];
}

export async function extensionPluginCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    note(PLUGIN_USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return new Promise((resolve) => {
    const child = spawn(npx, scaffoldArgs(argv), { stdio: 'inherit' });
    child.on('error', (error) => {
      note(`voyager plugin: could not run npx (${error.message}); install Node.js 18 or later`);
      resolve(2);
    });
    child.on('exit', (code) => resolve(code ?? 2));
  });
}
