import { randomBytes } from 'node:crypto';

/** URL-safe ids that satisfy the protocol's `ID_PATTERN`, sortable by creation time. */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}
