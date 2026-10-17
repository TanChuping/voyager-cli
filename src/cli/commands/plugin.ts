import { BRIDGE_PATHS, type JobSubmitResponse } from '@voyager-crew/bridge-protocol';

import { ensureServe } from '../../client/serveClient';
import type { CommandDef, ForegroundContext, VoyagerPlugin } from '../../plugins/api';
import type { PluginRegistry } from '../../plugins/registry';
import type { StatePaths } from '../../state/paths';
import { failure } from '../../util/errors';
import { parse, waitTimeout, WAIT_OPTIONS } from '../args';
import { note } from '../output';
import { submitAndWait } from './job';

/** `voyager <command> …` for a plugin command: prepare here, run in serve, wait, print. */
export async function pluginCommand(
  paths: StatePaths,
  registry: PluginRegistry,
  found: { plugin: VoyagerPlugin; command: string; def: CommandDef },
  argv: readonly string[],
): Promise<number> {
  const args = parse(argv, { ...WAIT_OPTIONS, ...found.def.options });
  const fg: ForegroundContext = {
    cwd: process.cwd(),
    stage: () =>
      Promise.reject(failure('bad-request', 'staging files is not available yet (Phase C)')),
    note,
  };
  const input = await found.def.prepare(fg, args);
  const client = await ensureServe(paths);
  return submitAndWait(
    client,
    registry,
    {
      json: args.options.json === true,
      noWait: args.options['no-wait'] === true,
      timeoutMs: waitTimeout(args),
    },
    () =>
      client.request<JobSubmitResponse>('POST', BRIDGE_PATHS.jobs, {
        plugin: found.plugin.name,
        command: found.command,
        input,
      }),
  );
}
