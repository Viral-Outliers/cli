// Shared fakes for the vitest suites (excluded from the tsc build).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from './request';
import type { RunDeps } from './run';

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  json?: unknown;
}

export type FakeHandler = (call: FetchCall, index: number) => FakeReply | Promise<FakeReply>;

export function fakeFetch(handler: FakeHandler): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: FetchCall = { url, method: init.method, headers: init.headers, body: init.body };
    if (init.body) {
      try {
        call.json = JSON.parse(init.body);
      } catch {
        call.json = undefined;
      }
    }
    const index = calls.length;
    calls.push(call);
    const reply = await handler(call, index);
    const lower = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status,
      headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
      text: async () => (reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
    };
  };
  return { fetch, calls };
}

export interface FakeDeps extends RunDeps {
  out: string[];
  err: string[];
  sleeps: number[];
  stdoutText(): string;
  stderrText(): string;
}

export function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'viral-outliers-cli-'));
}

/** Deps with an isolated (nonexistent) config file, a fake clock that advances on sleep, and captured stdio. */
export function makeDeps(fetch: FetchLike, overrides: Partial<RunDeps> = {}): FakeDeps {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: FakeDeps = {
    fetch,
    env: { VIRAL_OUTLIERS_CONFIG: join(tempConfigDir(), 'config.json') },
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    isTTY: false,
    stdinIsTTY: false,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    platform: 'linux',
    homedir: '/home/tester',
    out,
    err,
    sleeps,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
    ...overrides,
  };
  return deps;
}

export function lastJson(deps: FakeDeps): unknown {
  const lines = deps.stdoutText().trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}
