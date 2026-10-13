// Copies the package.json version into src/version.ts.
//
// Runs as the npm "version" lifecycle script, so `npm version patch|minor|major`
// rewrites the constant and stages it into the same commit as package.json.
// Without this the two drift on every bump: `--version` and the User-Agent keep
// reporting the old number, and the test that compares them fails, which stops
// `prepublishOnly` and the publish workflow before anything reaches npm.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../src/version.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const pattern = /CLI_VERSION = '[^']*'/;

if (!pattern.test(source)) {
  console.error('sync-version: could not find the CLI_VERSION constant in src/version.ts');
  process.exit(1);
}

writeFileSync(file, source.replace(pattern, `CLI_VERSION = '${version}'`));
console.log(`sync-version: src/version.ts is now ${version}`);
