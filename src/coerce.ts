// Turns raw parseArgs strings into the JSON values the API expects. Every flag
// is declared to parseArgs as a string (booleans included) so `--flag=false`
// is accepted; the types in the manifest drive the conversion here.
import type { CliManifestParam } from './manifest';

export class UsageError extends Error {
  readonly exitCode = 5;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const FALSE_WORDS = new Set(['false', '0', 'no']);

export function coerceBoolean(raw: string): boolean {
  return !FALSE_WORDS.has(raw.trim().toLowerCase());
}

export function coerceNumber(raw: string, flag: string): number {
  const trimmed = raw.trim();
  const n = trimmed === '' ? Number.NaN : Number(trimmed);
  if (Number.isNaN(n)) throw new UsageError(`--${flag} expects a number, got "${raw}"`);
  return n;
}

/** Repeated flags and comma-separated values both work; entries are trimmed and empties dropped. */
export function coerceStringList(raw: string | string[]): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export interface HandlePair {
  platform: string;
  handle: string;
}

/** `platform:handle`, split on the FIRST colon (handles may contain colons themselves). */
export function coerceHandlePairs(raw: string | string[], flag: string): HandlePair[] {
  return coerceStringList(raw).map((entry) => {
    const idx = entry.indexOf(':');
    if (idx <= 0 || idx === entry.length - 1) {
      throw new UsageError(`--${flag} expects platform:handle (e.g. --${flag} tiktok:creator), got "${entry}"`);
    }
    return { platform: entry.slice(0, idx).trim(), handle: entry.slice(idx + 1).trim() };
  });
}

export function coerceParam(param: CliManifestParam, raw: string | string[]): unknown {
  const single = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  switch (param.type) {
    case 'string':
      return single;
    case 'number':
      return coerceNumber(single, param.flag);
    case 'boolean':
      return coerceBoolean(single);
    case 'string[]':
      return coerceStringList(raw);
    case 'object[]':
      return coerceHandlePairs(raw, param.flag);
    default:
      return single;
  }
}
