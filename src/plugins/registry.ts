import { askPlugin } from '../../plugins/ask/index';
import type { CommandDef, VoyagerPlugin } from './api';
import { CALL_PLUGIN, callPlugin } from './callPlugin';

/** Official plugins ship in the package. Third-party npm plugins load here in Phase C. */
export const OFFICIAL_PLUGINS: readonly VoyagerPlugin[] = [askPlugin];

export class PluginRegistry {
  private readonly plugins = new Map<string, VoyagerPlugin>();

  constructor(plugins: readonly VoyagerPlugin[] = OFFICIAL_PLUGINS) {
    for (const plugin of [callPlugin, ...plugins]) this.plugins.set(plugin.name, plugin);
  }

  plugin(name: string): VoyagerPlugin | undefined {
    return this.plugins.get(name);
  }

  command(plugin: string, command: string): CommandDef | undefined {
    const commands = this.plugins.get(plugin)?.commands;
    return commands !== undefined && Object.hasOwn(commands, command)
      ? commands[command]
      : undefined;
  }

  /** Commands a person can run; the internal `call` plugin is listed as ops instead. */
  listCommands(): { plugin: string; command: string; summary: string }[] {
    return [...this.plugins.values()]
      .filter((plugin) => plugin.name !== CALL_PLUGIN)
      .flatMap((plugin) =>
        Object.entries(plugin.commands).map(([command, def]) => ({
          plugin: plugin.name,
          command,
          summary: def.summary,
        })),
      );
  }

  /** A foreground command name (`voyager ask`) → its plugin and command. */
  findCommand(
    name: string,
  ): { plugin: VoyagerPlugin; command: string; def: CommandDef } | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.name === CALL_PLUGIN) continue;
      if (Object.hasOwn(plugin.commands, name)) {
        return { plugin, command: name, def: plugin.commands[name] };
      }
    }
    return undefined;
  }
}
