/** Exit codes (spec §4.4); `voyager ask`, `call` and `job wait` share them. */
import { categoryOf, type BridgeError, type JobStatus } from '@voyager-crew/bridge-protocol';

export const EXIT = {
  ok: 0,
  failed: 2,
  needsUser: 3,
  waitTimeout: 4,
  busy: 5,
  transient: 6,
  offline: 7,
} as const;

export function exitForError(error: BridgeError): number {
  if (error.code === 'busy') return EXIT.busy;
  if (error.code === 'not-paired' || error.code === 'extension-offline') return EXIT.offline;
  const category = categoryOf(error.code);
  if (category === 'user-action') return EXIT.needsUser;
  if (category === 'data') return EXIT.failed;
  return EXIT.transient;
}

export function exitForJob(job: {
  readonly status: JobStatus;
  readonly error?: BridgeError;
}): number {
  if (job.status === 'succeeded') return EXIT.ok;
  if (job.status === 'detached') return EXIT.transient;
  if (job.error !== undefined) return exitForError(job.error);
  if (job.status === 'needs-user') return EXIT.needsUser;
  if (job.status === 'failed') return EXIT.failed;
  return EXIT.transient;
}
