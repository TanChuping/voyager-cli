import { categoryOf, type BridgeError } from '@voyager-crew/bridge-protocol';
import type { ServerResponse } from 'node:http';

import { BridgeFailure, failure } from '../util/errors';

/** A failure with an explicit HTTP status (403 for a forbidden Origin or Host). */
export class HttpFailure extends BridgeFailure {
  constructor(
    readonly status: number,
    error: BridgeError,
  ) {
    super(error);
  }
}

export function forbidden(message: string): HttpFailure {
  return new HttpFailure(403, failure('unauthorized', message).error);
}

export function statusFor(error: BridgeError): number {
  switch (error.code) {
    case 'busy':
      return 409;
    case 'gone':
      return 410;
    case 'not-found':
      return 404;
    case 'unauthorized':
      return 401;
    default:
      break;
  }
  const category = categoryOf(error.code);
  if (category === 'data') return 400;
  if (category === 'transient') return 503;
  // A person has to act first (not paired, offline extension, …).
  return 412;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/** No CORS headers, ever (spec §2.4). */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (status === 204) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendOk(res: ServerResponse, status: number, data: unknown): void {
  sendJson(res, status, { ok: true, data });
}

export function sendError(res: ServerResponse, thrown: BridgeFailure): void {
  const status = thrown instanceof HttpFailure ? thrown.status : statusFor(thrown.error);
  sendJson(res, status, { ok: false, error: thrown.error });
}
