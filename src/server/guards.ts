import {
  isExtensionOrigin,
  parseProtocolHeader,
  PROTOCOL,
  PROTOCOL_HEADER,
  type UpgradeSide,
} from '@voyager-crew/bridge-protocol';
/**
 * Request guards (spec §2.4). The server binds 127.0.0.1, and on top of that:
 * - Host must name this port on 127.0.0.1 or localhost (DNS rebinding);
 * - CLI endpoints refuse any request carrying an Origin, since every browser
 *   cross-origin POST carries one;
 * - open endpoints refuse every Origin except an extension's;
 * - extension endpoints need the paired Origin plus its bearer token.
 */
import type { IncomingMessage } from 'node:http';

import { failure } from '../util/errors';
import { safeEqual } from '../util/hash';
import { forbidden, HttpFailure } from './respond';

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function checkHost(req: IncomingMessage, port: number): void {
  const host = header(req, 'host');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw forbidden('Host header must be 127.0.0.1 or localhost with this port');
  }
}

export function bearer(req: IncomingMessage): string | undefined {
  const value = header(req, 'authorization');
  const match = value === undefined ? null : /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(value);
  return match?.[1];
}

export function checkCli(req: IncomingMessage, cliToken: string): void {
  if (header(req, 'origin') !== undefined) {
    throw forbidden('CLI endpoints do not accept requests with an Origin');
  }
  const token = bearer(req);
  if (token === undefined || !safeEqual(token, cliToken)) {
    throw failure('unauthorized', 'missing or wrong CLI token (~/.voyager/cli-token)');
  }
}

/** Open endpoints: no Origin (a CLI) or an extension Origin; `requireExtension` for `/v1/pair`. */
export function checkOpenOrigin(
  req: IncomingMessage,
  requireExtension: boolean,
): string | undefined {
  const origin = header(req, 'origin');
  if (origin === undefined) {
    if (requireExtension) throw forbidden('pairing has to come from the extension');
    return undefined;
  }
  if (!isExtensionOrigin(origin)) throw forbidden('requests from web pages are refused');
  return origin;
}

/** Every request but hello carries the negotiated protocol version. */
export function checkProtocol(req: IncomingMessage, client: UpgradeSide): void {
  const version = parseProtocolHeader(header(req, PROTOCOL_HEADER));
  if (version !== undefined && version >= PROTOCOL.min && version <= PROTOCOL.max) return;
  const upgrade: UpgradeSide = version !== undefined && version > PROTOCOL.max ? 'cli' : client;
  throw new HttpFailure(
    400,
    failure(
      'protocol-mismatch',
      `${PROTOCOL_HEADER} must be between ${PROTOCOL.min} and ${PROTOCOL.max}`,
      {
        supported: PROTOCOL,
        upgrade,
      },
    ).error,
  );
}
