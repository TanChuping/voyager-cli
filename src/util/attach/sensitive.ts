/**
 * Files that are never packed into an upload, whatever the folder's own
 * ignore rules say: environment files, keys, certificates and credential
 * stores. Matched on the file name and on every directory name of its path.
 */

const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(?:$|\.)/i, // .env, .env.local, .env.production, .env.example
  /\.env$/i, // production.env
  /\.(?:pem|key|p12|pfx|p8|jks|keystore|kdbx|mobileprovision|ppk|asc|gpg)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/i,
  /^\.?(?:npmrc|yarnrc\.yml|pypirc|netrc|git-credentials|dockercfg|htpasswd|pgpass|s3cfg)$/i,
  /^credentials(?:\.(?:json|ya?ml|toml|ini|xml))?$/i,
  /^client_secrets?[^/]*\.json$/i,
  /^service[-_]?account[^/]*\.json$/i,
  /^secrets?\.(?:json|ya?ml|toml|ini|env|txt)$/i,
  /^tokens?\.json$/i, // OAuth token caches
  /^known_hosts$/i,
  /^authorized_keys$/i,
];

const SENSITIVE_DIRS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube']);

/** True for a path (`/`-separated, relative) that names a credential or lies in a credential folder. */
export function isSensitivePath(relative: string): boolean {
  const segments = relative.split('/');
  const name = segments.at(-1) ?? '';
  if (segments.slice(0, -1).some((segment) => SENSITIVE_DIRS.has(segment.toLowerCase()))) {
    return true;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}
