// Command-line parsing on top of node:util parseArgs. Every manifest param is
// declared as a string option (booleans included) because parseArgs boolean
// options reject `--flag=false`; bare boolean flags are rewritten to
// `--flag=true` and `--no-flag` to `--flag=false` before parsing.
import { parseArgs } from 'node:util';
import { coerceParam, UsageError } from './coerce';
import type { CliManifestCommand } from './manifest';

export const DEFAULT_POLL_INTERVAL_SECONDS = 10;
export const MIN_POLL_INTERVAL_SECONDS = 2;
export const DEFAULT_TIMEOUT_SECONDS = 900;

export interface GlobalFlags {
  key?: string;
  baseUrl?: string;
  body?: Record<string, unknown>;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
  compact: boolean;
  quiet: boolean;
  wait: boolean;
  help: boolean;
  version: boolean;
}

type OptionSpec = { type: 'string' | 'boolean'; multiple?: boolean; short?: string };

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  key: { type: 'string' },
  'base-url': { type: 'string' },
  body: { type: 'string' },
  'poll-interval': { type: 'string' },
  timeout: { type: 'string' },
  compact: { type: 'boolean' },
  quiet: { type: 'boolean' },
  wait: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

export const GLOBAL_FLAG_NAMES = Object.keys(GLOBAL_OPTIONS);

/**
 * Rewrites boolean flags so parseArgs (string options) accepts every spelling:
 *   --flag            -> --flag=true
 *   --flag true|false -> --flag=true|false
 *   --no-flag         -> --flag=false
 * Stops at a literal `--`.
 */
export function normalizeBooleanFlags(argv: string[], booleanFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (token.startsWith('--no-') && booleanFlags.has(token.slice('--no-'.length))) {
      out.push(`--${token.slice('--no-'.length)}=false`);
      continue;
    }
    if (token.startsWith('--') && !token.includes('=') && booleanFlags.has(token.slice(2))) {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        out.push(`${token}=${next}`);
        i++;
      } else {
        out.push(`${token}=true`);
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

function unknownFlagFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const m = message.match(/Unknown option '(--?[^']+)'/);
  return m ? m[1] : null;
}

function buildOptions(cmd: CliManifestCommand | null): Record<string, OptionSpec> {
  const options: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS };
  for (const p of cmd?.params ?? []) {
    options[p.flag] = { type: 'string', multiple: p.type === 'string[]' || p.type === 'object[]' };
  }
  return options;
}

function runParseArgs(commandName: string, argv: string[], options: Record<string, OptionSpec>) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (error) {
    const flag = unknownFlagFromError(error);
    if (flag) throw new UsageError(`Unknown flag ${flag} for ${commandName}; run: viral-outliers help ${commandName}`);
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message}; run: viral-outliers help ${commandName}`);
  }
}

function readGlobals(values: Record<string, unknown>): GlobalFlags {
  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const bool = (k: string): boolean => values[k] === true;

  let body: Record<string, unknown> | undefined;
  const rawBody = str('body');
  if (rawBody !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new UsageError('--body must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError('--body must be a JSON object');
    }
    body = parsed as Record<string, unknown>;
  }

  let pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;
  const rawPoll = str('poll-interval');
  if (rawPoll !== undefined) {
    const n = Number(rawPoll);
    if (rawPoll.trim() === '' || Number.isNaN(n)) throw new UsageError(`--poll-interval expects seconds, got "${rawPoll}"`);
    pollIntervalSeconds = Math.max(MIN_POLL_INTERVAL_SECONDS, n);
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  const rawTimeout = str('timeout');
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (rawTimeout.trim() === '' || Number.isNaN(n) || n <= 0) throw new UsageError(`--timeout expects seconds, got "${rawTimeout}"`);
    timeoutSeconds = n;
  }

  return {
    key: str('key'),
    baseUrl: str('base-url'),
    body,
    pollIntervalSeconds,
    timeoutSeconds,
    compact: bool('compact'),
    quiet: bool('quiet'),
    wait: bool('wait'),
    help: bool('help'),
    version: bool('version'),
  };
}

export interface ParsedCommand {
  globals: GlobalFlags;
  /** JSON-ready params keyed by their API name (camelCase). */
  params: Record<string, unknown>;
  positionals: string[];
}

/** Parses only the global flags (meta commands like login/logout/commands). */
export function parseGlobalArgs(commandName: string, argv: string[]): { globals: GlobalFlags; positionals: string[] } {
  const parsed = runParseArgs(commandName, argv, buildOptions(null));
  return { globals: readGlobals(parsed.values as Record<string, unknown>), positionals: parsed.positionals };
}

/**
 * Parses the flags for one manifest command. Positionals fill the path params
 * in manifest order (an explicit flag wins); --body is merged OVER flag values
 * and may supply path params too. Missing required params are a usage error.
 */
export function parseCommandArgs(cmd: CliManifestCommand, argv: string[]): ParsedCommand {
  const booleanFlags = new Set(cmd.params.filter((p) => p.type === 'boolean').map((p) => p.flag));
  const normalized = normalizeBooleanFlags(argv, booleanFlags);
  const parsed = runParseArgs(cmd.name, normalized, buildOptions(cmd));
  const values = parsed.values as Record<string, unknown>;
  const globals = readGlobals(values);

  const params: Record<string, unknown> = {};
  for (const p of cmd.params) {
    const raw = values[p.flag];
    if (raw === undefined) continue;
    params[p.name] = coerceParam(p, raw as string | string[]);
  }

  const pathParams = cmd.params.filter((p) => p.inPath);
  const positionals = [...parsed.positionals];
  let next = 0;
  for (const p of pathParams) {
    if (next >= positionals.length) break;
    if (params[p.name] === undefined) params[p.name] = positionals[next];
    next++;
  }
  if (next < positionals.length && !globals.help) {
    throw new UsageError(
      `Unexpected argument "${positionals[next]}" for ${cmd.name}; run: viral-outliers help ${cmd.name}`,
    );
  }

  if (globals.body) Object.assign(params, globals.body);

  if (!globals.help) {
    const missing = cmd.params.filter((p) => p.required && (params[p.name] === undefined || params[p.name] === ''));
    if (missing.length > 0) {
      throw new UsageError(
        `Missing required flag${missing.length === 1 ? '' : 's'} for ${cmd.name}: ${missing.map((p) => `--${p.flag}`).join(', ')}; run: viral-outliers help ${cmd.name}`,
      );
    }
  }

  return { globals, params, positionals };
}
