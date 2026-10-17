import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { OptionDef, ParsedArgs } from '../plugins/api';
import { parseDuration } from '../util/duration';
import { failure } from '../util/errors';

type Options = NonNullable<ParseArgsConfig['options']>;

export function parse(
  argv: readonly string[],
  defs: Readonly<Record<string, OptionDef>>,
): ParsedArgs {
  const options: Options = {};
  for (const [name, def] of Object.entries(defs)) {
    options[name] = {
      type: def.type,
      ...(def.short === undefined ? {} : { short: def.short }),
      ...(def.multiple === undefined ? {} : { multiple: def.multiple }),
    };
  }
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { positionals, options: values };
  } catch (error) {
    throw failure('bad-request', error instanceof Error ? error.message : String(error));
  }
}

export const COMMON_OPTIONS: Readonly<Record<string, OptionDef>> = {
  json: { type: 'boolean', summary: 'print machine-readable JSON on stdout' },
};

export const WAIT_OPTIONS: Readonly<Record<string, OptionDef>> = {
  ...COMMON_OPTIONS,
  'no-wait': { type: 'boolean', summary: 'print the job id and return at once' },
  timeout: { type: 'string', summary: 'how long to wait (30m, 90s, 2h); the job keeps running' },
};

export const DEFAULT_WAIT_MS = 30 * 60_000;

export function waitTimeout(args: ParsedArgs): number {
  const raw = args.options.timeout;
  if (raw === undefined) return DEFAULT_WAIT_MS;
  const parsed = typeof raw === 'string' ? parseDuration(raw) : undefined;
  if (parsed === undefined) throw failure('bad-request', `cannot read --timeout ${String(raw)}`);
  return parsed;
}
