/**
 * `voyager`: the local half of the Voyager Local Bridge.
 * Built-ins are dispatched here; anything else is looked up among plugin commands.
 */
import { PluginRegistry } from '../plugins/registry';
import { statePaths } from '../state/paths';
import { BridgeFailure, toBridgeError } from '../util/errors';
import { CLI_VERSION } from '../version';
import { extensionPluginCommand } from './commands/extensionPlugin';
import { commandsCommand, statusCommand } from './commands/info';
import { callCommand, jobCommand } from './commands/job';
import { pairCommand } from './commands/pair';
import { pluginCommand } from './commands/plugin';
import { serveCommand } from './commands/serve';
import { exitForError } from './exitCodes';
import { note, printJson, printLine } from './output';

const USAGE = `voyager ${CLI_VERSION}: drive ChatGPT through the Voyager extension, locally

usage:
  voyager pair [--revoke]              pair the browser extension (one-time code)
  voyager ask "<prompt>" [--json]      new conversation, send, wait, save response.md
        [--attach <file|folder>]...    upload files; folders are zipped, credentials left out
        [--dry-run]                    pack attachments and print the job input, send nothing
        [--chat <link|id> | --continue] ask in an existing conversation, or the last one used
        [--timeout 30m] [--no-wait] [--keep-tab]
  voyager read <link|id> [--json]      save an existing conversation's last finished reply
  voyager status [--json]              serve, pairing and active job
  voyager commands [--json]            plugin commands and extension ops
  voyager call <op> [--params JSON]    run one extension op (debugging)
  voyager job list | show <id> | wait <id> [--timeout 30m] | cancel <id>
  voyager plugin create <dir> | check <dir>   write a Voyager extension plugin
  voyager serve [--foreground | --stop]

exit codes: 0 ok, 2 failed (data), 3 needs a person, 4 wait timed out (job continues),
            5 busy, 6 transient/detached, 7 not paired or extension offline
state: ~/.voyager (override with VOYAGER_HOME)`;

async function main(argv: readonly string[]): Promise<number> {
  const paths = statePaths();
  const registry = new PluginRegistry();
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printLine(USAGE);
      return 0;
    case '--version':
    case '-v':
      printLine(CLI_VERSION);
      return 0;
    case 'serve':
      return serveCommand(paths, rest);
    case 'pair':
      return pairCommand(paths, rest);
    case 'status':
      return statusCommand(paths, rest);
    case 'commands':
      return commandsCommand(paths, rest);
    case 'call':
      return callCommand(paths, registry, rest);
    case 'job':
      return jobCommand(paths, registry, rest);
    case 'plugin':
      return extensionPluginCommand(rest);
    default: {
      const found = registry.findCommand(command);
      if (found === undefined) {
        note(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
      }
      return pluginCommand(paths, registry, found, rest);
    }
  }
}

const argv = process.argv.slice(2);
main(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (thrown: unknown) => {
    const error = toBridgeError(thrown);
    if (argv.includes('--json')) printJson({ ok: false, error });
    else note(`voyager: ${error.code}: ${error.message}`);
    if (!(thrown instanceof BridgeFailure))
      note(String(thrown instanceof Error ? thrown.stack : thrown));
    process.exitCode = exitForError(error);
  },
);
