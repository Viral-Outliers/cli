// --wait: poll an asynchronous job to completion and collect its result.
//
// Rules that keep this safe with real money on the line:
//   * Only free endpoints are polled (GET /api/v1/jobs/{ref}, GET /api/v1/remixes/{ref}).
//   * A billed request is NEVER resubmitted because a job is slow. The one
//     deliberate re-call is download-post-media after completion (the API's
//     documented collect step, billed again), and it happens exactly once.
//   * Transient poll failures (429 / 5xx) keep waiting; other errors stop.
import type { CliManifestCommand } from './manifest';
import type { Writer } from './output';
import { buildPlan, type ApiResponse, type RequestContext, type RequestPlan } from './request';

export const WAITABLE_COMMANDS = [
  'request-transcript',
  'request-visual-analysis',
  'crawl-profile',
  'download-post-media',
  'remix-post',
] as const;

export function hasWaitHandler(commandName: string): boolean {
  return (WAITABLE_COMMANDS as readonly string[]).includes(commandName);
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface WaitDeps {
  send: (plan: RequestPlan) => Promise<ApiResponse>;
  ctx: RequestContext;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  stderr: Writer;
  quiet: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

export type WaitOutcome =
  /** Print this HTTP response exactly like a direct call (body + credits line). */
  | { type: 'response'; response: ApiResponse }
  /** Print this JSON value to stdout and exit with the given code. */
  | { type: 'json'; value: unknown; exitCode: number };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

type PollResult =
  | { kind: 'done'; last: JsonObject }
  | { kind: 'timeout'; last: JsonObject | null }
  | { kind: 'error'; response: ApiResponse };

async function pollUntil(
  deps: WaitDeps,
  path: string,
  jobRef: string,
  isTerminal: (json: JsonObject) => boolean,
): Promise<PollResult> {
  const start = deps.now();
  let last: JsonObject | null = null;
  for (;;) {
    const res = await deps.send(buildPlan('GET', path, deps.ctx));
    const elapsedSeconds = Math.round((deps.now() - start) / 1000);
    if (res.ok) {
      last = asObject(res.json);
      if (isTerminal(last)) return { kind: 'done', last };
      if (!deps.quiet) deps.stderr.write(`waiting ${jobRef}: ${String(last.status ?? 'unknown')} (${elapsedSeconds}s)\n`);
    } else if (res.status === 429 || res.status >= 500) {
      if (!deps.quiet) deps.stderr.write(`waiting ${jobRef}: poll returned HTTP ${res.status}, retrying (${elapsedSeconds}s)\n`);
    } else {
      return { kind: 'error', response: res };
    }

    const elapsedMs = deps.now() - start;
    if (elapsedMs >= deps.timeoutMs) return { kind: 'timeout', last };
    await deps.sleep(Math.max(0, Math.min(deps.pollIntervalMs, deps.timeoutMs - elapsedMs)));
  }
}

function timedOut(deps: WaitDeps, jobRef: string, last: JsonObject | null, fallback: unknown, pollHint: string): WaitOutcome {
  deps.stderr.write(
    `Timed out after ${Math.round(deps.timeoutMs / 1000)}s waiting for ${jobRef}. The job keeps running; check later with: ${pollHint}\n`,
  );
  return { type: 'json', value: last ?? fallback, exitCode: 1 };
}

function isFailedStatus(status: unknown): boolean {
  return status === 'failed' || status === 'cancelled';
}

/**
 * Drives --wait for one async command. `first` is the (2xx) submit response;
 * `firstPlan` is the exact request that produced it (re-sent only for
 * download-post-media's collect step).
 */
export async function waitForCommand(
  cmd: CliManifestCommand,
  first: ApiResponse,
  params: Record<string, unknown>,
  firstPlan: RequestPlan,
  deps: WaitDeps,
): Promise<WaitOutcome> {
  const submit = asObject(first.json);
  const jobRef = typeof submit.jobRef === 'string' && submit.jobRef ? submit.jobRef : null;
  // No job to wait for: dedup, already tracked, rejected up front, media already ready.
  if (!jobRef) return { type: 'response', response: first };
  const encodedRef = encodeURIComponent(jobRef);

  if (cmd.name === 'remix-post') {
    const result = await pollUntil(
      deps,
      `/api/v1/remixes/${encodedRef}`,
      jobRef,
      (json) => (json.remix !== null && json.remix !== undefined) || isFailedStatus(json.status),
    );
    if (result.kind === 'error') return { type: 'response', response: result.response };
    if (result.kind === 'timeout') {
      return timedOut(deps, jobRef, result.last, submit, `viral-outliers get-remix-result "${jobRef}"`);
    }
    return { type: 'json', value: result.last, exitCode: isFailedStatus(result.last.status) ? 1 : 0 };
  }

  const result = await pollUntil(deps, `/api/v1/jobs/${encodedRef}`, jobRef, (json) =>
    TERMINAL_JOB_STATUSES.has(String(json.status)),
  );
  if (result.kind === 'error') return { type: 'response', response: result.response };
  if (result.kind === 'timeout') {
    return timedOut(deps, jobRef, result.last, submit, `viral-outliers get-job-status "${jobRef}"`);
  }
  const job = result.last;
  const completed = job.status === 'completed';

  switch (cmd.name) {
    case 'request-transcript':
    case 'request-visual-analysis': {
      const postId =
        (typeof params.postId === 'string' && params.postId) ||
        (typeof submit.postId === 'string' && submit.postId) ||
        null;
      if (completed && postId) {
        const wantTranscript = cmd.name === 'request-transcript';
        const path = `/api/v1/posts/${encodeURIComponent(postId)}?includeTranscript=${wantTranscript}&includeVisualAnalysis=${!wantTranscript}`;
        const post = await deps.send(buildPlan('GET', path, deps.ctx));
        return { type: 'response', response: post };
      }
      if (completed) {
        deps.stderr.write('Job completed. Fetch the result with: viral-outliers get-post <postId>\n');
      }
      return { type: 'json', value: job, exitCode: completed ? 0 : 1 };
    }
    case 'crawl-profile':
      return { type: 'json', value: { submit, job }, exitCode: completed ? 0 : 1 };
    case 'download-post-media': {
      if (!completed) return { type: 'json', value: job, exitCode: 1 };
      // The documented collect step: the same call again, billed again (3 credits).
      const collected = await deps.send(firstPlan);
      return { type: 'response', response: collected };
    }
    default:
      return { type: 'json', value: job, exitCode: completed ? 0 : 1 };
  }
}
