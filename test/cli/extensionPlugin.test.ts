import { describe, expect, it } from 'vitest';

import { scaffoldArgs } from '../../src/cli/commands/extensionPlugin';

describe('voyager plugin', () => {
  it('runs the scaffold for create, under the name the scaffold gives it', () => {
    expect(scaffoldArgs(['create', 'my-plugin', '--site', 'claude'])).toEqual([
      '--yes',
      'create-voyager-plugin@latest',
      'init',
      'my-plugin',
      '--site',
      'claude',
    ]);
  });

  it('hands every other subcommand to create-voyager-plugin unchanged', () => {
    expect(scaffoldArgs(['check', 'my-plugin'])).toEqual([
      '--yes',
      'create-voyager-plugin@latest',
      'check',
      'my-plugin',
    ]);
  });
});
