/**
 * CLI-only endpoints that `@voyager-crew/bridge-protocol` does not list yet.
 * Both are local to voyager-cli: the extension never calls them.
 */
export const CLI_LOCAL_PATHS = {
  /** `GET`: state of a code from `POST /v1/pairing-codes`, so `voyager pair` can wait. */
  pairingCode: (code: string) => `/v1/pairing-codes/${encodeURIComponent(code)}`,
  /** `POST`: forget the paired extension (`voyager pair --revoke`). */
  unpair: '/v1/unpair',
} as const;
