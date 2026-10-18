/**
 * A file name safe to show ChatGPT and to create in a job folder: no path
 * separators, NUL or control characters, no leading dot, no trailing dots or
 * spaces, no Windows device name, at most {@link MAX_NAME_BYTES} UTF-8 bytes
 * (the extension kept). Case and Unicode are kept.
 */
const MAX_NAME_BYTES = 120;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

function truncateUtf8(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

export function sanitizeFileName(raw: string, fallback = 'file'): string {
  let name = raw
    .normalize('NFC')
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name === '') name = fallback;
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stem = truncateUtf8(
    name.slice(0, name.length - extension.length),
    MAX_NAME_BYTES - Buffer.byteLength(extension),
  );
  return `${stem}${extension}`;
}

/** `name`, or `stem-2.ext`, `stem-3.ext`… when `taken` already holds it (case-insensitive). */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
