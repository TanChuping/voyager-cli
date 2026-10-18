/**
 * A plugin's own small JSON state (`plugin-state/<plugin>.json`, 0600), kept
 * across jobs: `voyager project upload` remembers what it uploaded there.
 * Serve reads and writes it for the job that runs; nothing else does.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginState } from '../plugins/api';
import { readJsonFile, writeJsonAtomic } from '../util/files';
import type { StatePaths } from './paths';

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function pluginStateStore(paths: StatePaths, plugin: string): PluginState {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`not a plugin name: ${plugin}`);
  const file = join(paths.pluginState, `${plugin}.json`);
  return {
    read: () => readJsonFile(file),
    write: async (value) => {
      await mkdir(paths.pluginState, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(file, value);
    },
  };
}
