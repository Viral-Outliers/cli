import { describe, expect, it } from 'vitest';
import { normalizeBooleanFlags, parseCommandArgs, parseGlobalArgs } from './args';
import { UsageError } from './coerce';
import { findCommand, loadManifest, type CliManifestCommand } from './manifest';

const manifest = loadManifest();
const cmd = (name: string): CliManifestCommand => {
  const c = findCommand(manifest, name);
  if (!c) throw new Error(`missing command ${name}`);
  return c;
};

describe('normalizeBooleanFlags', () => {
  const bools = new Set(['include-transcript']);

  it('rewrites bare, valued and negated boolean flags', () => {
    expect(normalizeBooleanFlags(['--include-transcript'], bools)).toEqual(['--include-transcript=true']);
    expect(normalizeBooleanFlags(['--include-transcript', 'false'], bools)).toEqual(['--include-transcript=false']);
    expect(normalizeBooleanFlags(['--include-transcript', 'true', 'x'], bools)).toEqual(['--include-transcript=true', 'x']);
    expect(normalizeBooleanFlags(['--no-include-transcript'], bools)).toEqual(['--include-transcript=false']);
    expect(normalizeBooleanFlags(['--include-transcript=0'], bools)).toEqual(['--include-transcript=0']);
  });

  it('leaves non-boolean flags and everything after -- alone', () => {
    expect(normalizeBooleanFlags(['--query', 'x', '--', '--include-transcript'], bools)).toEqual([
      '--query',
      'x',
      '--',
      '--include-transcript',
    ]);
  });
});

describe('parseCommandArgs', () => {
  it('maps kebab flags to camelCase params with typed values', () => {
    const { params } = parseCommandArgs(cmd('search-outliers'), ['--query', 'test', '--min-outlier-score', '5', '--page-size', '20']);
    expect(params).toEqual({ query: 'test', minOutlierScore: 5, pageSize: 20 });
  });

  it('handles every boolean spelling', () => {
    const get = (argv: string[]) => parseCommandArgs(cmd('get-post'), ['p1', ...argv]).params;
    expect(get(['--include-transcript'])).toMatchObject({ includeTranscript: true });
    expect(get(['--include-transcript=false'])).toMatchObject({ includeTranscript: false });
    expect(get(['--include-transcript', 'false'])).toMatchObject({ includeTranscript: false });
    expect(get(['--no-include-transcript'])).toMatchObject({ includeTranscript: false });
    expect(get(['--include-transcript=0'])).toMatchObject({ includeTranscript: false });
    expect(get(['--include-transcript=no'])).toMatchObject({ includeTranscript: false });
    expect(get(['--include-transcript=yes'])).toMatchObject({ includeTranscript: true });
    expect(get([])).not.toHaveProperty('includeTranscript');
  });

  it('collects repeated and comma-separated string[] values', () => {
    const { params } = parseCommandArgs(cmd('search-outliers'), ['--platforms', 'tiktok, instagram', '--platforms', 'youtube,,']);
    expect(params.platforms).toEqual(['tiktok', 'instagram', 'youtube']);
  });

  it('parses --handles platform:handle pairs', () => {
    const { params } = parseCommandArgs(cmd('compare-profiles'), ['--handles', 'tiktok:a', '--handles', 'youtube:b:c']);
    expect(params.handles).toEqual([
      { platform: 'tiktok', handle: 'a' },
      { platform: 'youtube', handle: 'b:c' },
    ]);
  });

  it('rejects a handle without a colon with the example spelling', () => {
    expect(() => parseCommandArgs(cmd('compare-profiles'), ['--handles', 'tiktok'])).toThrow(/--handles tiktok:creator/);
  });

  it('fills path params from positionals, flag wins', () => {
    expect(parseCommandArgs(cmd('get-post'), ['abc']).params).toEqual({ postId: 'abc' });
    expect(parseCommandArgs(cmd('get-post'), ['abc', '--post-id', 'xyz']).params).toEqual({ postId: 'xyz' });
  });

  it('rejects unexpected positionals', () => {
    expect(() => parseCommandArgs(cmd('get-post'), ['abc', 'extra'])).toThrow(UsageError);
  });

  it('reports unknown flags as usage errors with the help hint', () => {
    let error: unknown;
    try {
      parseCommandArgs(cmd('get-post'), ['abc', '--bogus', '1']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(5);
    expect((error as UsageError).message).toBe('Unknown flag --bogus for get-post; run: viral-outliers help get-post');
  });

  it('lists missing required flags', () => {
    expect(() => parseCommandArgs(cmd('crawl-profile'), [])).toThrow(/Missing required flags for crawl-profile: --platform, --handle/);
    expect(() => parseCommandArgs(cmd('crawl-profile'), ['--platform', 'tiktok'])).toThrow(/--handle/);
  });

  it('merges --body over flag values and lets it supply path params', () => {
    const { params } = parseCommandArgs(cmd('search-outliers'), ['--query', 'a', '--page', '1', '--body', '{"query":"b","page":2}']);
    expect(params).toEqual({ query: 'b', page: 2 });
    expect(parseCommandArgs(cmd('get-post'), ['--body', '{"postId":"from-body"}']).params).toEqual({ postId: 'from-body' });
  });

  it('rejects invalid --body JSON and non-numeric numbers', () => {
    expect(() => parseCommandArgs(cmd('search-outliers'), ['--body', '{nope'])).toThrow(/--body must be valid JSON/);
    expect(() => parseCommandArgs(cmd('search-outliers'), ['--body', '[1]'])).toThrow(/JSON object/);
    expect(() => parseCommandArgs(cmd('search-outliers'), ['--min-views', 'lots'])).toThrow(/--min-views expects a number/);
  });

  it('reads global flags with defaults and clamps', () => {
    const { globals } = parseCommandArgs(cmd('search-outliers'), ['--key', 'k', '--base-url', 'http://x', '--compact', '--quiet']);
    expect(globals).toMatchObject({ key: 'k', baseUrl: 'http://x', compact: true, quiet: true, wait: false, pollIntervalSeconds: 10, timeoutSeconds: 900 });
    expect(parseCommandArgs(cmd('crawl-profile'), ['--platform', 'a', '--handle', 'b', '--poll-interval', '1', '--timeout', '30']).globals).toMatchObject({
      pollIntervalSeconds: 2,
      timeoutSeconds: 30,
    });
    expect(() => parseCommandArgs(cmd('search-outliers'), ['--timeout', 'soon'])).toThrow(UsageError);
  });

  it('parses global-only argv for meta commands', () => {
    expect(parseGlobalArgs('login', ['--key', 'so_live_x']).globals.key).toBe('so_live_x');
    expect(() => parseGlobalArgs('login', ['--nope'])).toThrow(/Unknown flag --nope for login/);
  });
});
