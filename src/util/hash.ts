import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 32 random bytes, base64url (43 characters, `PAIRING_TOKEN_PATTERN`). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison for secrets of the same encoding. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
