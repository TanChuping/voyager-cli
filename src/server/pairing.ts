import type { BridgeBrowser, PairingCodeResponse } from '@voyager-crew/bridge-protocol';
/**
 * Pairing (spec §2.3): `voyager pair` asks for an eight-digit code, the
 * extension redeems it once for a token. Only `sha256(token)` reaches disk.
 * One pairing per server (Q7 default): a new pairing replaces the old one, and
 * the replaced token is remembered so its next poll is told `unpaired`.
 */
import { randomInt } from 'node:crypto';

import type { StatePaths } from '../state/paths';
import { failure } from '../util/errors';
import { readJsonFile, writeJsonAtomic } from '../util/files';
import { newToken, safeEqual, sha256Hex } from '../util/hash';
import { newId } from '../util/ids';
import { isRecord } from '../util/isRecord';

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const MAX_FAILED_ATTEMPTS = 5;
const MAX_REVOKED = 16;

export interface PairingRecord {
  readonly origin: string;
  readonly tokenSha256: string;
  readonly browser: BridgeBrowser;
  readonly extensionVersion: string;
  readonly pairedAt: number;
}

interface PairingFile {
  readonly serverId: string;
  readonly current: PairingRecord | null;
  readonly revoked: readonly string[];
}

export type CodeState =
  | { readonly state: 'pending'; readonly expiresAt: number }
  | { readonly state: 'paired'; readonly browser: BridgeBrowser; readonly extensionVersion: string }
  | { readonly state: 'expired' };

interface IssuedCode {
  readonly code: string;
  readonly expiresAt: number;
  status: 'pending' | 'used' | 'void';
  pairing?: PairingRecord;
}

export type TokenCheck = 'ok' | 'revoked' | 'bad-token' | 'bad-origin';

export class PairingStore {
  private file: PairingFile = { serverId: newId('s'), current: null, revoked: [] };
  private readonly codes = new Map<string, IssuedCode>();
  private failedAttempts = 0;

  constructor(
    private readonly paths: StatePaths,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const raw = await readJsonFile(this.paths.pairings);
    if (isRecord(raw) && typeof raw.serverId === 'string') {
      this.file = {
        serverId: raw.serverId,
        current: readRecord(raw.current),
        revoked: Array.isArray(raw.revoked)
          ? raw.revoked.filter((hash): hash is string => typeof hash === 'string')
          : [],
      };
    }
    await this.save();
  }

  get serverId(): string {
    return this.file.serverId;
  }

  get current(): PairingRecord | null {
    return this.file.current;
  }

  issueCode(): PairingCodeResponse {
    this.expireCodes();
    let code: string;
    do code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    while (this.codes.has(code));
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, expiresAt, status: 'pending' });
    return { code, expiresAt };
  }

  codeState(code: string): CodeState | undefined {
    this.expireCodes();
    const issued = this.codes.get(code);
    if (issued === undefined) return undefined;
    if (issued.status === 'pending') return { state: 'pending', expiresAt: issued.expiresAt };
    if (issued.status === 'used' && issued.pairing !== undefined) {
      return {
        state: 'paired',
        browser: issued.pairing.browser,
        extensionVersion: issued.pairing.extensionVersion,
      };
    }
    return { state: 'expired' };
  }

  /** Redeem a code for a token. Five wrong codes void every code still pending. */
  async redeem(input: {
    code: string;
    origin: string;
    browser: BridgeBrowser;
    extensionVersion: string;
  }): Promise<string> {
    this.expireCodes();
    const match = [...this.codes.values()].find(
      (issued) => issued.status === 'pending' && safeEqual(issued.code, input.code),
    );
    if (match === undefined) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        for (const issued of this.codes.values()) {
          if (issued.status === 'pending') issued.status = 'void';
        }
        this.failedAttempts = 0;
      }
      throw failure('unauthorized', 'pairing code is wrong, used or expired');
    }
    const token = newToken();
    const record: PairingRecord = {
      origin: input.origin,
      tokenSha256: sha256Hex(token),
      browser: input.browser,
      extensionVersion: input.extensionVersion,
      pairedAt: this.now(),
    };
    match.status = 'used';
    match.pairing = record;
    this.failedAttempts = 0;
    this.file = {
      ...this.file,
      current: record,
      revoked: this.withRevoked(this.file.current),
    };
    await this.save();
    return token;
  }

  checkToken(token: string | undefined, origin: string | undefined): TokenCheck {
    if (token === undefined) return 'bad-token';
    const hash = sha256Hex(token);
    const current = this.file.current;
    if (current !== null && safeEqual(hash, current.tokenSha256)) {
      return origin === current.origin ? 'ok' : 'bad-origin';
    }
    return this.file.revoked.some((revoked) => safeEqual(revoked, hash)) ? 'revoked' : 'bad-token';
  }

  async revoke(): Promise<boolean> {
    const had = this.file.current !== null;
    this.file = { ...this.file, current: null, revoked: this.withRevoked(this.file.current) };
    await this.save();
    return had;
  }

  private withRevoked(record: PairingRecord | null): string[] {
    const revoked =
      record === null ? [...this.file.revoked] : [...this.file.revoked, record.tokenSha256];
    return revoked.slice(-MAX_REVOKED);
  }

  private expireCodes(): void {
    const now = this.now();
    for (const issued of this.codes.values()) {
      if (issued.status === 'pending' && issued.expiresAt <= now) issued.status = 'void';
    }
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.paths.pairings, this.file, 0o600);
  }
}

function readRecord(raw: unknown): PairingRecord | null {
  if (!isRecord(raw)) return null;
  const { origin, tokenSha256, browser, extensionVersion, pairedAt } = raw;
  if (
    typeof origin !== 'string' ||
    typeof tokenSha256 !== 'string' ||
    (browser !== 'chrome' && browser !== 'edge' && browser !== 'firefox') ||
    typeof extensionVersion !== 'string' ||
    typeof pairedAt !== 'number'
  ) {
    return null;
  }
  return { origin, tokenSha256, browser, extensionVersion, pairedAt };
}
