const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** `90s`, `30m`, `2h`, `500ms`; a bare number is seconds. Undefined when unreadable. */
export function parseDuration(input: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(input);
  if (!match) return undefined;
  const value = Number(match[1]) * UNITS[match[2] ?? 's'];
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
