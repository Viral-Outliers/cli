import { describe, expect, it } from 'vitest';
import { run } from './run';
import { fakeFetch, lastJson, makeDeps, type FakeReply } from './test-helpers';

const KEY = 'so_live_test';
const withKey = { VIRAL_OUTLIERS_API_KEY: KEY };

describe('--wait', () => {
  it('is rejected for synchronous commands', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['search-outliers', '--query', 'x', '--wait'], deps)).toBe(5);
    expect(calls.length).toBe(0);
    expect(deps.stderrText()).toContain('--wait is only supported for asynchronous commands');
  });

  it('request-transcript: polls pending -> completed, then fetches the post with its transcript', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST' && call.url.endsWith('/api/v1/transcriptions')) {
        return { status: 200, body: { queued: true, jobRef: 'ai:job-1', postId: 'p1', message: 'queued' }, headers: { 'X-Credits-Charged': '10', 'X-Credits-Balance': '90' } };
      }
      if (call.url.endsWith('/api/v1/jobs/ai%3Ajob-1')) {
        polls++;
        return { status: 200, body: { jobRef: 'ai:job-1', kind: 'ai', status: polls < 3 ? (polls === 1 ? 'pending' : 'processing') : 'completed' } };
      }
      if (call.url.endsWith('/api/v1/posts/p1?includeTranscript=true&includeVisualAnalysis=false')) {
        return { status: 200, body: { post: { id: 'p1' }, transcript: { text: 'hello' } }, headers: { 'X-Credits-Charged': '1', 'X-Credits-Balance': '89' } };
      }
      return { status: 500, body: { error: { code: 'unexpected', message: call.url } } };
    });
    const deps = makeDeps(fetch, { env: withKey });

    const code = await run(['request-transcript', '--post-id', 'p1', '--wait'], deps);
    expect(code).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'GET', 'GET']);
    expect(calls[0].json).toEqual({ postId: 'p1' });
    expect(calls[1].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(lastJson(deps)).toEqual({ post: { id: 'p1' }, transcript: { text: 'hello' } });
    expect(deps.sleeps).toEqual([10_000, 10_000]);
    const err = deps.stderrText();
    expect(err).toContain('credits: charged=10 balance=90');
    expect(err).toContain('waiting ai:job-1: pending (0s)');
    expect(err).toContain('waiting ai:job-1: processing (10s)');
    expect(err).toContain('credits: charged=1 balance=89');
  });

  it('request-visual-analysis: uses the postId from the submit response when only a url was given', async () => {
    const { fetch, calls } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { queued: true, jobRef: 'ai:v', postId: 'p9', message: 'queued' } };
      if (call.url.includes('/jobs/')) return { status: 200, body: { status: 'completed' } };
      if (call.url.includes('/posts/p9?includeTranscript=false&includeVisualAnalysis=true')) return { status: 200, body: { post: { id: 'p9' }, visualAnalysis: {} } };
      return { status: 500, body: {} };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['request-visual-analysis', '--url', 'https://www.tiktok.com/@a/video/1', '--wait', '--quiet'], deps)).toBe(0);
    expect(calls.length).toBe(3);
    expect(lastJson(deps)).toEqual({ post: { id: 'p9' }, visualAnalysis: {} });
    expect(deps.stderrText()).toBe('');
  });

  it('request-transcript: a failed job prints the job status and exits 1', async () => {
    const { fetch, calls } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { queued: true, jobRef: 'ai:f' } };
      return { status: 200, body: { jobRef: 'ai:f', status: 'failed', error: 'no audio' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['request-transcript', '--url', 'https://x/1', '--wait'], deps)).toBe(1);
    expect(calls.length).toBe(2);
    expect(lastJson(deps)).toMatchObject({ status: 'failed' });
  });

  it('request-transcript: completed without a known postId prints the job and a get-post hint', async () => {
    const { fetch } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { queued: true, jobRef: 'ai:n' } };
      return { status: 200, body: { jobRef: 'ai:n', status: 'completed' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['request-transcript', '--url', 'https://x/1', '--wait'], deps)).toBe(0);
    expect(lastJson(deps)).toMatchObject({ status: 'completed' });
    expect(deps.stderrText()).toContain('viral-outliers get-post <postId>');
  });

  it('short-circuits when the submit response carries no jobRef', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { alreadyTracked: true, queued: false, profileId: 'pr1', message: 'tracked' }, headers: { 'X-Credits-Charged': '0' } }));
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['crawl-profile', '--platform', 'tiktok', '--handle', 'a', '--wait'], deps)).toBe(0);
    expect(calls.length).toBe(1);
    expect(lastJson(deps)).toEqual({ alreadyTracked: true, queued: false, profileId: 'pr1', message: 'tracked' });
    expect(deps.sleeps).toEqual([]);
  });

  it('crawl-profile: prints { submit, job } once the crawl completes', async () => {
    const submit = { alreadyTracked: false, queued: true, jobRef: 'crawl:tiktok:a:posts_crawl', message: 'queued' };
    const { fetch, calls } = fakeFetch((call, i): FakeReply => {
      if (i === 0) return { status: 200, body: submit };
      return { status: 200, body: { jobRef: submit.jobRef, kind: 'crawl', status: i === 1 ? 'processing' : 'completed' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['crawl-profile', '--platform', 'tiktok', '--handle', 'a', '--wait', '--poll-interval', '3'], deps)).toBe(0);
    expect(calls[1].url).toContain('/api/v1/jobs/crawl%3Atiktok%3Aa%3Aposts_crawl');
    expect(lastJson(deps)).toEqual({ submit, job: { jobRef: submit.jobRef, kind: 'crawl', status: 'completed' } });
    expect(deps.sleeps).toEqual([3000]);
  });

  it('download-post-media: re-POSTs the same request once the fetch completes', async () => {
    const { fetch, calls } = fakeFetch((call, i): FakeReply => {
      if (call.method === 'POST' && i === 0) return { status: 200, body: { ready: false, jobRef: 'crawl:tiktok:1:fetch_media_urls', retryAfterSeconds: 90, note: 'wait' } };
      if (call.method === 'POST') return { status: 200, body: { ready: true, media: [{ type: 'video', url: 'https://cdn/x.mp4' }], note: 'ok' }, headers: { 'X-Credits-Charged': '3' } };
      return { status: 200, body: { status: 'completed' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['download-post-media', '--post-id', 'p1', '--wait'], deps)).toBe(0);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(2);
    expect(calls[0].body).toBe(calls[2].body);
    expect(lastJson(deps)).toMatchObject({ ready: true });
  });

  it('download-post-media: a failed fetch prints the job and exits 1 without re-billing', async () => {
    const { fetch, calls } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { ready: false, jobRef: 'crawl:x', retryAfterSeconds: 90, note: '' } };
      return { status: 200, body: { status: 'failed' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['download-post-media', '--post-id', 'p1', '--wait'], deps)).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
  });

  it('remix-post: polls get-remix-result until remix is populated', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { queued: true, jobRef: 'pipeline:abc', recreateId: 'r', postId: 'p', message: 'queued' } };
      polls++;
      return polls < 2
        ? { status: 200, body: { jobRef: 'pipeline:abc', status: 'processing', remix: null } }
        : { status: 200, body: { jobRef: 'pipeline:abc', status: 'completed', remix: { title: 'Adapted' } } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['remix-post', '--url', 'https://x/1', '--target-niche', 'B2B SaaS founders', '--wait'], deps)).toBe(0);
    expect(calls[1].url).toBe('https://viraloutliers.com/api/v1/remixes/pipeline%3Aabc');
    expect(calls.every((c, i) => i === 0 || !c.url.includes('/jobs/'))).toBe(true);
    expect(lastJson(deps)).toEqual({ jobRef: 'pipeline:abc', status: 'completed', remix: { title: 'Adapted' } });
  });

  it('remix-post: a failed remix exits 1', async () => {
    const { fetch } = fakeFetch((call): FakeReply =>
      call.method === 'POST'
        ? { status: 200, body: { queued: true, jobRef: 'pipeline:bad' } }
        : { status: 200, body: { jobRef: 'pipeline:bad', status: 'failed', remix: null } },
    );
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['remix-post', '--post-id', 'p', '--target-niche', 'Fitness coaches', '--wait'], deps)).toBe(1);
  });

  it('times out: prints the last status, exits 1, and never resubmits', async () => {
    const { fetch, calls } = fakeFetch((call): FakeReply =>
      call.method === 'POST' ? { status: 200, body: { queued: true, jobRef: 'ai:slow' } } : { status: 200, body: { jobRef: 'ai:slow', status: 'processing' } },
    );
    const deps = makeDeps(fetch, { env: withKey });
    const code = await run(['request-transcript', '--post-id', 'p1', '--wait', '--timeout', '25', '--poll-interval', '10'], deps);
    expect(code).toBe(1);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
    expect(deps.sleeps).toEqual([10_000, 10_000, 5_000]);
    expect(lastJson(deps)).toEqual({ jobRef: 'ai:slow', status: 'processing' });
    expect(deps.stderrText()).toContain('Timed out after 25s');
    expect(deps.stderrText()).toContain('viral-outliers get-job-status "ai:slow"');
  });

  it('keeps polling through transient 5xx poll errors but stops on a 404', async () => {
    let polls = 0;
    const { fetch } = fakeFetch((call): FakeReply => {
      if (call.method === 'POST') return { status: 200, body: { queued: true, jobRef: 'ai:t' } };
      polls++;
      if (polls === 1) return { status: 503, body: { error: { code: 'temporarily_unavailable', message: 'later' } } };
      return { status: 200, body: { status: 'completed' } };
    });
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['request-transcript', '--url', 'https://x/1', '--wait'], deps)).toBe(0);
    expect(polls).toBe(2);

    const gone = fakeFetch((call): FakeReply =>
      call.method === 'POST' ? { status: 200, body: { queued: true, jobRef: 'ai:g' } } : { status: 404, body: { error: { code: 'not_found', message: 'Job not found' } } },
    );
    const d2 = makeDeps(gone.fetch, { env: withKey });
    expect(await run(['request-transcript', '--url', 'https://x/1', '--wait'], d2)).toBe(1);
    expect(d2.stderrText()).toContain('not_found');
  });

  it('a failed submit is printed as an error without polling', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 402, body: { error: { code: 'insufficient_credits', message: 'no credits' } } }));
    const deps = makeDeps(fetch, { env: withKey });
    expect(await run(['remix-post', '--post-id', 'p', '--target-niche', 'Fitness coaches', '--wait'], deps)).toBe(2);
    expect(calls.length).toBe(1);
  });
});

describe('meta commands and dispatch', () => {
  it('prints version, global help, the commands table and command help', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
    const v = makeDeps(fetch);
    expect(await run(['--version'], v)).toBe(0);
    expect(v.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const h = makeDeps(fetch);
    expect(await run([], h)).toBe(0);
    expect(h.stdoutText()).toContain('Usage: viral-outliers <command> [flags]');

    const c = makeDeps(fetch);
    expect(await run(['commands'], c)).toBe(0);
    expect(c.stdoutText()).toContain('search-outliers');
    expect(c.stdoutText()).toContain('login [--key so_live_...]');

    const ch = makeDeps(fetch);
    expect(await run(['help', 'get-post'], ch)).toBe(0);
    expect(ch.stdoutText()).toContain('Usage: viral-outliers get-post <post-id> [flags]');
    expect(ch.stdoutText()).toContain('--include-transcript');
    expect(ch.stdoutText()).toContain('1 credit ($0.01)');

    const flag = makeDeps(fetch);
    expect(await run(['download-post-media', '--help'], flag)).toBe(0);
    expect(flag.stdoutText()).toContain('billed again (3 credits ($0.03))');
  });

  it('unknown commands and unknown help targets are usage errors', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
    const d = makeDeps(fetch);
    expect(await run(['nope'], d)).toBe(5);
    expect(d.stderrText()).toContain('Unknown command "nope"');
    expect(await run(['help', 'nope'], d)).toBe(5);
  });

  it('a network failure after the retry exits 1 with a message', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const d = makeDeps(fetch, { env: withKey });
    expect(await run(['get-pricing'], d)).toBe(1);
    expect(d.stderrText()).toContain('Network error');
  });
});
