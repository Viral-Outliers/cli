// Where the saved API key lives and how a key is resolved for a request.
//
// Precedence: --key > $VIRAL_OUTLIERS_API_KEY > config file. The file path is
// $VIRAL_OUTLIERS_CONFIG (full path override, used by tests), else
// $XDG_CONFIG_HOME/viral-outliers/config.json, else the platform default.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';

export const API_KEY_PREFIX = 'so_live_';
export const CONFIG_PATH_ENV = 'VIRAL_OUTLIERS_CONFIG';

export type EnvMap = Record<string, string | undefined>;

export interface CliConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ConfigLocation {
  env: EnvMap;
  platform?: string;
  homedir?: string;
}

export function configPath({ env, platform = process.platform, homedir = osHomedir() }: ConfigLocation): string {
  const override = env[CONFIG_PATH_ENV];
  if (override && override.trim()) return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim()) return join(xdg, 'viral-outliers', 'config.json');
  if (platform === 'win32') {
    const appData = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : join(homedir, 'AppData', 'Roaming');
    return join(appData, 'viral-outliers', 'config.json');
  }
  return join(homedir, '.config', 'viral-outliers', 'config.json');
}

export function readConfig(location: ConfigLocation): CliConfig {
  const file = configPath(location);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const out: CliConfig = {};
    if (typeof obj.apiKey === 'string' && obj.apiKey) out.apiKey = obj.apiKey;
    if (typeof obj.baseUrl === 'string' && obj.baseUrl) out.baseUrl = obj.baseUrl;
    return out;
  } catch {
    return {};
  }
}

/** Writes the config with owner-only permissions (best effort; Windows ignores modes). */
export function writeConfig(location: ConfigLocation, config: CliConfig): string {
  const file = configPath(location);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(dir, 0o700);
    chmodSync(file, 0o600);
  } catch {
    // Not supported on this filesystem/platform; the mode on create is the best we can do.
  }
  return file;
}

/** Removes the config file. Returns true when a file was actually deleted. */
export function deleteConfig(location: ConfigLocation): boolean {
  const file = configPath(location);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export type KeySource = 'flag' | 'env' | 'config';

export interface ResolvedKey {
  key: string | null;
  source: KeySource | null;
}

export function resolveApiKey(flagKey: string | undefined, env: EnvMap, envVar: string, config: CliConfig): ResolvedKey {
  if (flagKey && flagKey.trim()) return { key: flagKey.trim(), source: 'flag' };
  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  if (config.apiKey) return { key: config.apiKey, source: 'config' };
  return { key: null, source: null };
}

export function looksLikeApiKey(key: string): boolean {
  return key.startsWith(API_KEY_PREFIX);
}
