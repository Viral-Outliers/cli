import { describe, expect, it } from 'vitest';
import { findCommand, loadManifest, type CliManifestCommand } from './manifest';
import { buildPlan, buildRequest, NetworkError, sendRequest, type RequestContext } from './request';
import { fakeFetch } from './test-helpers';

const manifest = loadManifest();
const cmd = (name: string): CliManifestCommand => {
  const c = findCommand(manifest, name);
  if (!c) throw new Error(`missing command ${name}`);
  return c;
};
const ctx: RequestContext = { baseUrl: 'https://viraloutliers.com', apiKey: 'so_live_abc', version: '0.1.0' };

describe('buildRequest', () => {
  it('encodes GET params in the query string (booleans, arrays, numbers)', () => {
    const plan = buildRequest(cmd('get-post'), { postId: 'p 1', includeTranscript: false, includeVisualAnalysis: true }, ctx);
    expect(plan.method).toBe('GET');
    expect(plan.url).toBe('https://viraloutliers.com/api/v1/posts/p%201?includeTranscript=false&includeVisualAnalysis=true');
    expect(plan.body).toBeUndefined();
    expect(plan.headers['Content-Type']).toBeUndefined();

    const fake: CliManifestCommand = { ...cmd('get-tracked-updates'), path: '/api/v1/x', params: [] };
    const arr = buildRequest(fake, { tags: ['a', 'b'], limit: 5 }, ctx);
    expect(arr.url).toBe('https://viraloutliers.com/api/v1/x?tags=a%2Cb&limit=5');
  });

  it('sends DELETE scalars in the query and the full param set as JSON body', () => {
    const plan = buildRequest(cmd('remove-watchlist-profiles'), { watchlistId: 'w1', profileIds: ['a', 'b'] }, ctx);
    expect(plan.method).toBe('DELETE');
    expect(plan.url).toBe('https://viraloutliers.com/api/v1/watchlists/profiles?watchlistId=w1');
    expect(JSON.parse(plan.body ?? '')).toEqual({ watchlistId: 'w1', profileIds: ['a', 'b'] });
    expect(plan.headers['Content-Type']).toBe('application/json');
  });

  it('sends POST params as a JSON body', () => {
    const plan = buildRequest(cmd('search-outliers'), { query: 'x', platforms: ['tiktok'], minViews: 10 }, ctx);
    expect(plan.method).toBe('POST');
    expect(plan.url).toBe('https://viraloutliers.com/api/v1/search/content');
    expect(JSON.parse(plan.body ?? '')).toEqual({ query: 'x', platforms: ['tiktok'], minViews: 10 });
  });

  it('URL-encodes path params such as job refs with colons', () => {
    const plan = buildRequest(cmd('get-job-status'), { jobRef: 'crawl:tiktok:handle:posts_crawl' }, ctx);
    expect(plan.url).toBe('https://viraloutliers.com/api/v1/jobs/crawl%3Atiktok%3Ahandle%3Aposts_crawl');
    expect(buildRequest(cmd('get-remix-result'), { jobRef: 'pipeline:abc' }, ctx).url).toContain('/remixes/pipeline%3Aabc');
  });

  it('honours a base-url override and strips trailing slashes', () => {
    const plan = buildRequest(cmd('get-pricing'), {}, { ...ctx, baseUrl: 'http://localhost:3000///' });
    expect(plan.url).toBe('http://localhost:3000/api/v1/pricing');
  });

  it('sets User-Agent and Accept, and omits Authorization without a key', () => {
    const withKey = buildRequest(cmd('get-pricing'), {}, ctx);
    expect(withKey.headers.Authorization).toBe('Bearer so_live_abc');
    expect(withKey.headers['User-Agent']).toBe('viral-outliers-cli/0.1.0');
    expect(withKey.headers.Accept).toBe('application/json');
    const noKey = buildRequest(cmd('get-pricing'), {}, { ...ctx, apiKey: null });
    expect(noKey.headers.Authorization).toBeUndefined();
  });

  it('builds ad-hoc plans for polling', () => {
    const plan = buildPlan('GET', '/api/v1/jobs/ai%3A1', ctx);
    expect(plan.url).toBe('https://viraloutliers.com/api/v1/jobs/ai%3A1');
    expect(plan.body).toBeUndefined();
  });
});

describe('sendRequest', () => {
  it('parses JSON bodies and exposes headers', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ok: 1 }, headers: { 'X-Credits-Charged': '1' } }));
    const res = await sendRequest(buildPlan('GET', '/x', ctx), fetch);
    expect(res.ok).toBe(true);
    expect(res.json).toEqual({ ok: 1 });
    expect(res.headers.get('x-credits-charged')).toBe('1');
  });

  it('retries exactly once on a network error, then surfaces NetworkError', async () => {
    let attempts = 0;
    const flaky = fakeFetch(() => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return { status: 200, body: { ok: true } };
    });
    const res = await sendRequest(buildPlan('GET', '/x', ctx), flaky.fetch);
    expect(res.ok).toBe(true);
    expect(attempts).toBe(2);

    let dead = 0;
    const down = fakeFetch(() => {
      dead++;
      throw new TypeError('fetch failed');
    });
    await expect(sendRequest(buildPlan('GET', '/x', ctx), down.fetch)).rejects.toBeInstanceOf(NetworkError);
    expect(dead).toBe(2);
  });

  it('never retries an HTTP error status', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500, body: { error: { code: 'internal_error', message: 'boom' } } }));
    const res = await sendRequest(buildPlan('POST', '/x', ctx, { a: 1 }), fetch);
    expect(res.status).toBe(500);
    expect(calls.length).toBe(1);
  });
});
