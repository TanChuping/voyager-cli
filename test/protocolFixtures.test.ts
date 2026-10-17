import {
  isMessageKind,
  isOpName,
  validateMessage,
  validateOpParams,
  validateOpResult,
  type Validation,
} from '@voyager-crew/bridge-protocol';
/**
 * The protocol package's golden fixtures, run here too: voyager-cli accepts
 * and refuses exactly the messages the extension does. `run()` is copied from
 * the package's own fixtures.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface FixtureCase {
  readonly name: string;
  readonly kind: string;
  readonly op?: string;
  readonly input: unknown;
  readonly issuePath?: string;
}

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@voyager-crew/bridge-protocol/fixtures',
);

function loadCases(folder: 'valid' | 'invalid'): [string, FixtureCase][] {
  const dir = join(FIXTURES, folder);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const cases = JSON.parse(readFileSync(join(dir, file), 'utf8')) as FixtureCase[];
      return cases.map((entry): [string, FixtureCase] => [`${file}: ${entry.name}`, entry]);
    });
}

function run(entry: FixtureCase): Validation<unknown> {
  if (entry.kind === 'opParams' || entry.kind === 'opResult') {
    if (!isOpName(entry.op)) throw new Error(`fixture names an unknown op: ${entry.op}`);
    return entry.kind === 'opParams'
      ? validateOpParams(entry.op, entry.input)
      : validateOpResult(entry.op, entry.input);
  }
  if (!isMessageKind(entry.kind)) throw new Error(`fixture names an unknown kind: ${entry.kind}`);
  return validateMessage(entry.kind, entry.input);
}

describe('bridge protocol fixtures', () => {
  it('finds the fixtures', () => {
    expect(loadCases('valid').length).toBeGreaterThan(0);
    expect(loadCases('invalid').length).toBeGreaterThan(0);
  });

  it.each(loadCases('valid'))('accepts %s', (_label, entry) => {
    const result = run(entry);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each(loadCases('invalid'))('refuses %s', (_label, entry) => {
    const result = run(entry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(entry.issuePath);
  });
});
