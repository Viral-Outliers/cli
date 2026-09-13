// Builds and sends one HTTP request for a manifest command. Zero dependencies:
// global fetch + AbortSignal.timeout. Network failures are retried ONCE; HTTP
// statuses are never retried (a billed call must not be blindly resubmitted).
import { UsageError } from './coerce';
import type { CliManifestCommand } from './manifest';

export const REQUEST_TIMEOUT_MS = 30_000;

export interface RequestPlan {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  /** Raw body text. */
  text: string;
  /** Parsed JSON body when the body parsed; undefined otherwise. */
  json: unknown;
  isJson: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface RequestContext {
  baseUrl: string;
  apiKey: string | null;
  version: string;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function queryValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)));
    return parts.join(',');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isScalar(value: unknown): boolean {
  return value !== null && value !== undefined && typeof value !== 'object';
}

export function substitutePath(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      throw new UsageError(`Missing path parameter ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function buildHeaders(ctx: RequestContext, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `viral-outliers-cli/${ctx.version}`,
    Accept: 'application/json',
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
  return headers;
}

/**
 * GET: params in the query string (arrays comma-joined, booleans true/false).
 * POST: JSON body.
 * DELETE: scalars in the query string AND the full param set as a JSON body
 * (some routes read one field from each).
 */
export function buildRequest(cmd: CliManifestCommand, params: Record<string, unknown>, ctx: RequestContext): RequestPlan {
  const path = substitutePath(cmd.path, params);
  const inPath = new Set(cmd.params.filter((p) => p.inPath).map((p) => p.name));
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (inPath.has(k) || v === undefined) continue;
    rest[k] = v;
  }

  const base = normalizeBaseUrl(ctx.baseUrl);
  if (cmd.method === 'POST') {
    return { method: 'POST', url: `${base}${path}`, headers: buildHeaders(ctx, true), body: JSON.stringify(rest) };
  }

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    if (cmd.method === 'DELETE' && !isScalar(v)) continue;
    const qv = queryValue(v);
    if (qv !== null) query.set(k, qv);
  }
  const qs = query.toString();
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;

  if (cmd.method === 'DELETE') {
    return { method: 'DELETE', url, headers: buildHeaders(ctx, true), body: JSON.stringify(rest) };
  }
  return { method: 'GET', url, headers: buildHeaders(ctx, false) };
}

/** A plan for an ad-hoc call (polling, follow-up fetches) under the same auth/base. */
export function buildPlan(method: RequestPlan['method'], path: string, ctx: RequestContext, body?: unknown): RequestPlan {
  const hasBody = body !== undefined;
  return {
    method,
    url: `${normalizeBaseUrl(ctx.baseUrl)}${path}`,
    headers: buildHeaders(ctx, hasBody),
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  };
}

export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name: unknown }).name);
    return name === 'AbortError' || name === 'TimeoutError';
  }
  return false;
}

async function attempt(plan: RequestPlan, fetchImpl: FetchLike, timeoutMs: number): Promise<ApiResponse> {
  const res = await fetchImpl(plan.url, {
    method: plan.method,
    headers: plan.headers,
    ...(plan.body !== undefined ? { body: plan.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  let isJson = false;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text, json, isJson };
}

export async function sendRequest(
  plan: RequestPlan,
  fetchImpl: FetchLike,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ApiResponse> {
  try {
    return await attempt(plan, fetchImpl, timeoutMs);
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    try {
      return await attempt(plan, fetchImpl, timeoutMs);
    } catch (again) {
      const detail = again instanceof Error ? again.message : String(again);
      throw new NetworkError(`Network error calling ${plan.method} ${plan.url}: ${detail}`, again);
    }
  }
}
