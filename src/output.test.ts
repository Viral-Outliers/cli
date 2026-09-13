import { describe, expect, it } from 'vitest';
import { exitCodeForStatus, printError, printSuccess, SETTINGS_URL, TOPUP_HINT, type OutputOptions } from './output';
import type { ApiResponse } from './request';

function opts(overrides: Partial<OutputOptions> = {}): OutputOptions & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    isTTY: false,
    compact: false,
    quiet: false,
    out,
    err,
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let json: unknown;
  let isJson = false;
  try {
    json = JSON.parse(text);
    isJson = true;
  } catch {
    isJson = false;
  }
  return { status, ok: status >= 200 && status < 300, headers: { get: (n) => lower.get(n.toLowerCase()) ?? null }, text, json, isJson };
}

describe('exitCodeForStatus', () => {
  it('maps statuses to the documented exit codes', () => {
    expect(exitCodeForStatus(401)).toBe(4);
    expect(exitCodeForStatus(402)).toBe(2);
    expect(exitCodeForStatus(429)).toBe(3);
    expect(exitCodeForStatus(400)).toBe(1);
    expect(exitCodeForStatus(404)).toBe(1);
    expect(exitCodeForStatus(500)).toBe(1);
    expect(exitCodeForStatus(503)).toBe(1);
  });
});

describe('printSuccess', () => {
  it('prints single-line JSON when not a TTY and the credits line on stderr', () => {
    const o = opts();
    const code = printSuccess(response(200, { a: 1 }, { 'X-Credits-Charged': '1', 'X-Credits-Balance': '99' }), o);
    expect(code).toBe(0);
    expect(o.out.join('')).toBe('{"a":1}\n');
    expect(o.err.join('')).toBe('credits: charged=1 balance=99\n');
  });

  it('pretty-prints on a TTY unless --compact, and says unknown for a missing balance', () => {
    const tty = opts({ isTTY: true });
    printSuccess(response(200, { a: 1 }, { 'X-Credits-Charged': '0' }), tty);
    expect(tty.out.join('')).toBe('{\n  "a": 1\n}\n');
    expect(tty.err.join('')).toBe('credits: charged=0 balance=unknown\n');

    const compact = opts({ isTTY: true, compact: true, quiet: true });
    printSuccess(response(200, { a: 1 }, { 'X-Credits-Charged': '0' }), compact);
    expect(compact.out.join('')).toBe('{"a":1}\n');
    expect(compact.err).toEqual([]);
  });

  it('prints nothing about credits for free unauthenticated endpoints', () => {
    const o = opts();
    printSuccess(response(200, []), o);
    expect(o.err).toEqual([]);
  });
});

describe('printError', () => {
  it('401 prints the body and the login hint, exit 4', () => {
    const o = opts();
    const code = printError(response(401, { error: { code: 'missing_api_key', message: 'no key' } }), o);
    expect(code).toBe(4);
    expect(o.out).toEqual([]);
    expect(o.err.join('')).toContain('"missing_api_key"');
    expect(o.err.join('')).toContain('Run: viral-outliers login\n');
  });

  it('402 with a checkout link prints the message and Pay here, exit 2', () => {
    const o = opts();
    const code = printError(
      response(402, {
        error: { code: 'payment_required', message: 'Buy credits to continue.', payment: { checkoutUrl: 'https://checkout.stripe.com/x', instructions: 'pay' } },
      }),
      o,
    );
    expect(code).toBe(2);
    const err = o.err.join('');
    expect(err).toContain('Buy credits to continue.\n');
    expect(err).toContain('Pay here: https://checkout.stripe.com/x\n');
    expect(err).not.toContain(TOPUP_HINT);
  });

  it('402 without a checkout link prints the top-up hint and settings URL', () => {
    const o = opts();
    const code = printError(response(402, { error: { code: 'insufficient_credits', message: 'This call costs 1 credit but your balance is 0.' } }), o);
    expect(code).toBe(2);
    const err = o.err.join('');
    expect(err).toContain('This call costs 1 credit but your balance is 0.\n');
    expect(err).toContain(`${TOPUP_HINT}\n${SETTINGS_URL}\n`);
  });

  it('429 exits 3 and other statuses exit 1', () => {
    expect(printError(response(429, { error: { code: 'rate_limited', message: 'slow down' } }), opts())).toBe(3);
    expect(printError(response(400, { error: { code: 'invalid_params', message: 'bad' } }), opts())).toBe(1);
    expect(printError(response(503, { error: { code: 'billing_unavailable', message: 'later' } }), opts())).toBe(1);
  });

  it('non-JSON bodies print the status and the first 200 characters, exit 1', () => {
    const o = opts();
    const code = printError(response(502, `<html>${'x'.repeat(500)}</html>`), o);
    expect(code).toBe(1);
    const line = o.err.join('');
    expect(line.startsWith('HTTP 502: <html>')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('HTTP 502: '.length + 200 + 1);
  });
});
