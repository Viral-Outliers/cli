import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, deleteConfig, readConfig, resolveApiKey, writeConfig } from './config';
import { run } from './run';
import { fakeFetch, makeDeps, tempConfigDir } from './test-helpers';

describe('configPath', () => {
  const home = '/home/u';

  it('prefers the explicit override, then XDG_CONFIG_HOME', () => {
    expect(configPath({ env: { VIRAL_OUTLIERS_CONFIG: '/tmp/x.json', XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homedir: home })).toBe('/tmp/x.json');
    expect(configPath({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homedir: home })).toBe(join('/xdg', 'viral-outliers', 'config.json'));
    expect(configPath({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'win32', homedir: home })).toBe(join('/xdg', 'viral-outliers', 'config.json'));
  });

  it('uses APPDATA on Windows with a Roaming fallback', () => {
    expect(configPath({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u' })).toBe(
      join('C:\\Users\\u\\AppData\\Roaming', 'viral-outliers', 'config.json'),
    );
    expect(configPath({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' })).toBe(
      join('C:\\Users\\u', 'AppData', 'Roaming', 'viral-outliers', 'config.json'),
    );
  });

  it('uses ~/.config elsewhere', () => {
    expect(configPath({ env: {}, platform: 'darwin', homedir: home })).toBe(join(home, '.config', 'viral-outliers', 'config.json'));
    expect(configPath({ env: {}, platform: 'linux', homedir: home })).toBe(join(home, '.config', 'viral-outliers', 'config.json'));
  });
});

describe('resolveApiKey', () => {
  it('prefers --key over the env var over the config file', () => {
    const env = { VIRAL_OUTLIERS_API_KEY: 'so_live_env' };
    expect(resolveApiKey('so_live_flag', env, 'VIRAL_OUTLIERS_API_KEY', { apiKey: 'so_live_cfg' })).toEqual({ key: 'so_live_flag', source: 'flag' });
    expect(resolveApiKey(undefined, env, 'VIRAL_OUTLIERS_API_KEY', { apiKey: 'so_live_cfg' })).toEqual({ key: 'so_live_env', source: 'env' });
    expect(resolveApiKey(undefined, {}, 'VIRAL_OUTLIERS_API_KEY', { apiKey: 'so_live_cfg' })).toEqual({ key: 'so_live_cfg', source: 'config' });
    expect(resolveApiKey(undefined, {}, 'VIRAL_OUTLIERS_API_KEY', {})).toEqual({ key: null, source: null });
  });
});

describe('writeConfig / readConfig / deleteConfig', () => {
  it('round-trips and applies owner-only permissions on POSIX', () => {
    const file = join(tempConfigDir(), 'nested', 'config.json');
    const loc = { env: { VIRAL_OUTLIERS_CONFIG: file } };
    expect(readConfig(loc)).toEqual({});
    expect(writeConfig(loc, { apiKey: 'so_live_x', baseUrl: 'http://localhost:3000' })).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ apiKey: 'so_live_x', baseUrl: 'http://localhost:3000' });
    expect(readConfig(loc)).toEqual({ apiKey: 'so_live_x', baseUrl: 'http://localhost:3000' });
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    }
    expect(deleteConfig(loc)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(deleteConfig(loc)).toBe(false);
  });
});

describe('key handling through run()', () => {
  it('sends no Authorization header when no key is available, and still makes the call', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 401, body: { error: { code: 'missing_api_key', message: 'no' } } }));
    const deps = makeDeps(fetch);
    const code = await run(['search-outliers', '--query', 'test'], deps);
    expect(code).toBe(4);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(deps.stderrText()).toContain('Run: viral-outliers login');
  });

  it('uses the env var, and --key wins over it', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { balance: 5 }, headers: { 'X-Credits-Charged': '0' } }));
    const deps = makeDeps(fetch, { env: { VIRAL_OUTLIERS_API_KEY: 'so_live_env', VIRAL_OUTLIERS_CONFIG: join(tempConfigDir(), 'c.json') } });
    expect(await run(['get-credit-balance'], deps)).toBe(0);
    expect(calls[0].headers.Authorization).toBe('Bearer so_live_env');
    expect(await run(['whoami', '--key', 'so_live_flag'], deps)).toBe(0);
    expect(calls[1].headers.Authorization).toBe('Bearer so_live_flag');
  });

  it('warns when the key does not look like an API key, unless --quiet', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { balance: 5 } }));
    const deps = makeDeps(fetch);
    await run(['get-credit-balance', '--key', 'nope'], deps);
    expect(deps.stderrText()).toContain('does not start with so_live_');
    const quiet = makeDeps(fetch);
    await run(['get-credit-balance', '--key', 'nope', '--quiet'], quiet);
    expect(quiet.stderrText()).toBe('');
  });

  it('login validates the key, saves it, and later calls read it from the file', async () => {
    const file = join(tempConfigDir(), 'config.json');
    const { fetch, calls } = fakeFetch((call) =>
      call.headers.Authorization === 'Bearer so_live_good'
        ? { status: 200, body: { balance: 42 }, headers: { 'X-Credits-Charged': '0' } }
        : { status: 401, body: { error: { code: 'invalid_api_key', message: 'bad' } } },
    );
    const deps = makeDeps(fetch, { env: { VIRAL_OUTLIERS_CONFIG: file } });

    expect(await run(['login', '--key', 'so_live_bad'], deps)).toBe(4);
    expect(existsSync(file)).toBe(false);
    expect(deps.stderrText()).toContain('rejected');

    expect(await run(['login', '--key', 'so_live_good'], deps)).toBe(0);
    expect(calls[1].url).toBe('https://viraloutliers.com/api/v1/credits');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ apiKey: 'so_live_good' });
    expect(deps.stdoutText()).toContain('Credit balance: 42');

    expect(await run(['get-credit-balance'], deps)).toBe(0);
    expect(calls[2].headers.Authorization).toBe('Bearer so_live_good');

    expect(await run(['logout'], deps)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('login without a key and without a terminal is a usage error', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { balance: 1 } }));
    const deps = makeDeps(fetch);
    expect(await run(['login'], deps)).toBe(5);
  });

  it('config baseUrl is used, and --base-url overrides it', async () => {
    const file = join(tempConfigDir(), 'config.json');
    writeConfig({ env: { VIRAL_OUTLIERS_CONFIG: file } }, { apiKey: 'so_live_x', baseUrl: 'http://localhost:3000/' });
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: [] }));
    const deps = makeDeps(fetch, { env: { VIRAL_OUTLIERS_CONFIG: file } });
    await run(['get-pricing'], deps);
    expect(calls[0].url).toBe('http://localhost:3000/api/v1/pricing');
    await run(['get-pricing', '--base-url', 'https://staging.example.com/'], deps);
    expect(calls[1].url).toBe('https://staging.example.com/api/v1/pricing');
  });
});
