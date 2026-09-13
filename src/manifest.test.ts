import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCommandHelp, renderCommandsTable, renderGlobalHelp } from './help';
import { loadManifest } from './manifest';
import { CLI_VERSION } from './version';
import { hasWaitHandler, WAITABLE_COMMANDS } from './wait';

const root = join(__dirname, '..');
const EM_DASH = String.fromCharCode(0x2014);

describe('manifest', () => {
  const manifest = loadManifest();

  it('loads with schemaVersion 1 and at least one command', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.apiBase).toBe('https://viraloutliers.com');
    expect(manifest.envVar).toBe('VIRAL_OUTLIERS_API_KEY');
    expect(manifest.commands.length).toBeGreaterThan(10);
  });

  it('contains no em dashes', () => {
    expect(JSON.stringify(manifest)).not.toContain(EM_DASH);
  });

  it('has a --wait handler for every async command, and only for async commands', () => {
    for (const cmd of manifest.commands) {
      expect(hasWaitHandler(cmd.name), cmd.name).toBe(cmd.isAsync);
    }
    for (const name of WAITABLE_COMMANDS) {
      expect(manifest.commands.find((c) => c.name === name)?.isAsync, name).toBe(true);
    }
  });

  it('uses unique kebab-case names and flags', () => {
    const names = manifest.commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const cmd of manifest.commands) {
      expect(cmd.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const flags = cmd.params.map((p) => p.flag);
      expect(new Set(flags).size, cmd.name).toBe(flags.length);
    }
  });
});

describe('package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    bin: Record<string, string>;
  };

  it('has zero runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {}).length).toBe(0);
  });

  it('keeps CLI_VERSION in sync with package.json', () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('exposes the bin', () => {
    expect(pkg.bin['viral-outliers']).toBe('dist/cli.js');
  });
});

describe('user-facing text', () => {
  const manifest = loadManifest();

  it('help output contains no em dashes', () => {
    expect(renderGlobalHelp(manifest, CLI_VERSION)).not.toContain(EM_DASH);
    expect(renderCommandsTable(manifest)).not.toContain(EM_DASH);
    for (const cmd of manifest.commands) expect(renderCommandHelp(cmd), cmd.name).not.toContain(EM_DASH);
  });

  it('source files and README contain no em dashes', () => {
    const files = readdirSync(join(root, 'src'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(root, 'src', f));
    files.push(join(root, 'README.md'));
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(EM_DASH);
    }
  });
});
