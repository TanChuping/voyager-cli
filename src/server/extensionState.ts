import type { OpCapability, OpName } from '@voyager-crew/bridge-protocol';

/** What the server last heard from the paired extension, in memory only. */
export class ExtensionState {
  lastPollAt: number | null = null;
  ops: readonly OpCapability[] | null = null;
  policy: { readonly revision: number; readonly allowed: boolean } | null = null;

  opNames(): ReadonlySet<OpName> | null {
    return this.ops === null ? null : new Set(this.ops.map((op) => op.name));
  }

  forget(): void {
    this.lastPollAt = null;
    this.ops = null;
    this.policy = null;
  }
}
