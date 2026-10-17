/**
 * Failures carry a protocol `BridgeError`, so the category an agent sees is
 * always the one `@voyager-crew/bridge-protocol` assigns to the code.
 */
import {
  bridgeError,
  isErrorCode,
  type BridgeError,
  type ErrorCode,
} from '@voyager-crew/bridge-protocol';

import { isRecord } from './isRecord';

export class BridgeFailure extends Error {
  readonly error: BridgeError;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = 'BridgeFailure';
    this.error = error;
  }

  get code(): ErrorCode {
    return this.error.code;
  }
}

export function failure(
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): BridgeFailure {
  return new BridgeFailure(bridgeError(code, message, details));
}

/** Anything thrown inside a plugin or handler, as a protocol error. */
export function toBridgeError(thrown: unknown): BridgeError {
  if (thrown instanceof BridgeFailure) return thrown.error;
  if (isRecord(thrown) && isErrorCode(thrown.code) && typeof thrown.message === 'string') {
    return bridgeError(thrown.code, thrown.message);
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  // No protocol code means "internal"; `bad-request` keeps it in the data category, so
  // the caller stops instead of retrying.
  return bridgeError('bad-request', `internal error: ${message}`);
}
