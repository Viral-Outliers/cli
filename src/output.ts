// Printing rules: JSON body to stdout on success, error body to stderr with a
// status-derived exit code, metering line to stderr.
import type { ApiResponse } from './request';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PAYMENT_REQUIRED = 2;
export const EXIT_RATE_LIMITED = 3;
export const EXIT_AUTH = 4;
export const EXIT_USAGE = 5;

export const TOPUP_HINT = 'Top up: viral-outliers create-topup-link --pack-id pack_s   (free)';
export const SETTINGS_URL = 'https://viraloutliers.com/settings?tab=api-keys';

export interface Writer {
  write(chunk: string): unknown;
}

export interface OutputOptions {
  stdout: Writer;
  stderr: Writer;
  /** stdout is a terminal: pretty-print unless --compact. */
  isTTY: boolean;
  compact: boolean;
  quiet: boolean;
}

export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT_AUTH;
  if (status === 402) return EXIT_PAYMENT_REQUIRED;
  if (status === 429) return EXIT_RATE_LIMITED;
  return EXIT_ERROR;
}

export function formatJson(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

export function shouldPretty(opts: Pick<OutputOptions, 'isTTY' | 'compact'>): boolean {
  return opts.isTTY && !opts.compact;
}

/** `credits: charged=<n> balance=<m|unknown>` when the response was metered. */
export function printCreditsLine(headers: ApiResponse['headers'], opts: OutputOptions): void {
  if (opts.quiet) return;
  const charged = headers.get('x-credits-charged');
  if (charged === null) return;
  const balance = headers.get('x-credits-balance');
  opts.stderr.write(`credits: charged=${charged} balance=${balance ?? 'unknown'}\n`);
}

export function printJson(value: unknown, opts: OutputOptions): void {
  opts.stdout.write(`${formatJson(value, shouldPretty(opts))}\n`);
}

/** Prints a 2xx response and returns exit code 0. */
export function printSuccess(res: ApiResponse, opts: OutputOptions): number {
  if (res.isJson) printJson(res.json, opts);
  else if (res.text.length > 0) opts.stdout.write(`${res.text}\n`);
  printCreditsLine(res.headers, opts);
  return EXIT_OK;
}

interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    payment?: { checkoutUrl?: unknown; instructions?: unknown };
  };
}

/** Prints a non-2xx response to stderr and returns the exit code for it. */
export function printError(res: ApiResponse, opts: OutputOptions): number {
  if (!res.isJson) {
    const snippet = res.text.slice(0, 200);
    opts.stderr.write(`HTTP ${res.status}${snippet ? `: ${snippet}` : ''}\n`);
    return EXIT_ERROR;
  }

  opts.stderr.write(`${formatJson(res.json, !opts.compact)}\n`);
  printCreditsLine(res.headers, opts);

  const envelope = (res.json && typeof res.json === 'object' ? res.json : {}) as ErrorEnvelope;
  const message = typeof envelope.error?.message === 'string' ? envelope.error.message : null;
  const code = exitCodeForStatus(res.status);

  if (res.status === 401) {
    opts.stderr.write('Run: viral-outliers login\n');
  } else if (res.status === 402) {
    if (message) opts.stderr.write(`${message}\n`);
    const checkoutUrl = envelope.error?.payment?.checkoutUrl;
    if (typeof checkoutUrl === 'string' && checkoutUrl) {
      opts.stderr.write(`Pay here: ${checkoutUrl}\n`);
    } else {
      opts.stderr.write(`${TOPUP_HINT}\n${SETTINGS_URL}\n`);
    }
  }
  return code;
}

/** Prints any response (2xx or not) and returns the exit code. */
export function printResponse(res: ApiResponse, opts: OutputOptions): number {
  return res.ok ? printSuccess(res, opts) : printError(res, opts);
}
