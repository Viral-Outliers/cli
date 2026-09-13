// Human-facing help text. No em dashes anywhere in here (owner rule).
import type { CliManifest, CliManifestCommand, CliManifestParam } from './manifest';
import { DEFAULT_POLL_INTERVAL_SECONDS, DEFAULT_TIMEOUT_SECONDS, MIN_POLL_INTERVAL_SECONDS } from './args';
import { hasWaitHandler } from './wait';

/** Mirrors USD_PER_CREDIT in the Viral Outliers pricing config; the manifest does not carry it. */
export const USD_PER_CREDIT = 0.01;

export const DOCS_URL = 'https://viraloutliers.com/docs/cli';

export interface MetaCommand {
  name: string;
  usage: string;
  summary: string;
}

export const META_COMMANDS: MetaCommand[] = [
  { name: 'login', usage: 'login [--key so_live_...]', summary: 'Validate an API key against the API and save it for future calls.' },
  { name: 'logout', usage: 'logout', summary: 'Delete the saved API key.' },
  { name: 'whoami', usage: 'whoami', summary: 'Show the credit balance for the active key (alias for get-credit-balance).' },
  { name: 'commands', usage: 'commands', summary: 'List every command with its cost, route and summary.' },
  { name: 'help', usage: 'help <command>', summary: 'Show usage, flags and cost for one command.' },
];

export function formatUsd(credits: number): string {
  return `$${(credits * USD_PER_CREDIT).toFixed(2)}`;
}

export function formatCost(cost: number): string {
  if (cost <= 0) return 'free';
  return `${cost} credit${cost === 1 ? '' : 's'} (${formatUsd(cost)})`;
}

export function wrap(text: string, width = 80, indent = ''): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > width - indent.length) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

export function usageLine(cmd: CliManifestCommand): string {
  const positionals = cmd.params.filter((p) => p.inPath).map((p) => `<${p.flag}>`);
  const parts = ['viral-outliers', cmd.name, ...positionals];
  if (cmd.params.some((p) => !p.inPath)) parts.push('[flags]');
  if (cmd.isAsync) parts.push('[--wait]');
  return parts.join(' ');
}

function flagUsage(p: CliManifestParam): string {
  switch (p.type) {
    case 'boolean':
      return `--${p.flag} [true|false]`;
    case 'number':
      return `--${p.flag} <number>`;
    case 'string[]':
      return `--${p.flag} <a,b> (repeatable)`;
    case 'object[]':
      return `--${p.flag} <platform:handle> (repeatable)`;
    default:
      return `--${p.flag} <string>`;
  }
}

function asyncNote(cmd: CliManifestCommand): string | null {
  if (!cmd.isAsync) return null;
  const base = 'Asynchronous: the call returns a jobRef immediately. Poll it for free with get-job-status, or add --wait to let the CLI poll';
  switch (cmd.name) {
    case 'request-transcript':
      return `${base} and, once completed, fetch the post with its transcript via get-post (that fetch costs 1 credit).`;
    case 'request-visual-analysis':
      return `${base} and, once completed, fetch the post with its visual analysis via get-post (that fetch costs 1 credit).`;
    case 'crawl-profile':
      return `${base} until the crawl finishes and print { submit, job }.`;
    case 'download-post-media':
      return `${base} until the media fetch completes, then repeat this call to collect the URLs. That collect call is billed again (${formatCost(cmd.cost)}).`;
    case 'remix-post':
      return `${base} get-remix-result (free) until the remix is populated and print it.`;
    default:
      return hasWaitHandler(cmd.name) ? `${base} until it finishes.` : base + '.';
  }
}

export function renderGlobalFlags(): string {
  const rows: [string, string][] = [
    ['--key <so_live_...>', 'API key for this call. Else $VIRAL_OUTLIERS_API_KEY, else the key saved by login.'],
    ['--base-url <url>', 'API origin to call (default https://viraloutliers.com).'],
    ['--body <json>', 'JSON object merged over the flag values; wins on conflict. Path params allowed.'],
    ['--wait', 'Async commands only: poll the job until it finishes and print the result.'],
    ['--poll-interval <s>', `Seconds between polls with --wait (default ${DEFAULT_POLL_INTERVAL_SECONDS}, min ${MIN_POLL_INTERVAL_SECONDS}).`],
    ['--timeout <s>', `Give up on --wait after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}).`],
    ['--compact', 'Single-line JSON even when stdout is a terminal.'],
    ['--quiet', 'Suppress the credits line, progress and warnings on stderr.'],
    ['-h, --help', 'Show help.'],
    ['-v, --version', 'Print the CLI version.'],
  ];
  const width = Math.max(...rows.map(([f]) => f.length)) + 2;
  return rows.map(([flag, text]) => `  ${pad(flag, width)}${text}`).join('\n');
}

export function renderCommandHelp(cmd: CliManifestCommand): string {
  const lines: string[] = [];
  lines.push(`${cmd.name}: ${cmd.title}`);
  lines.push(`  ${cmd.method} ${cmd.path}`);
  lines.push(`  Cost: ${formatCost(cmd.cost)}${cmd.requiresAuth ? '' : '  (no API key needed)'}`);
  lines.push('');
  lines.push(wrap(cmd.description, 80));
  lines.push('');
  const note = asyncNote(cmd);
  if (note) {
    lines.push(wrap(note, 80));
    lines.push('');
  }
  lines.push(`Usage: ${usageLine(cmd)}`);
  if (cmd.params.length > 0) {
    lines.push('');
    lines.push('Flags:');
    const usages = cmd.params.map((p) => flagUsage(p));
    const width = Math.max(...usages.map((u) => u.length)) + 2;
    cmd.params.forEach((p, i) => {
      const meta = [p.type, p.required ? 'required' : 'optional', p.inPath ? 'positional' : null].filter(Boolean).join(', ');
      lines.push(`  ${pad(usages[i], width)}(${meta})`);
      lines.push(wrap(p.description, 80, ' '.repeat(width + 4)));
    });
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push(renderGlobalFlags());
  lines.push('');
  lines.push(`Docs: ${DOCS_URL}`);
  return `${lines.join('\n')}\n`;
}

export function renderCommandsTable(manifest: CliManifest): string {
  const billable = manifest.commands.filter((c) => c.cost > 0);
  const free = manifest.commands.filter((c) => c.cost <= 0);
  const nameWidth = Math.max(...manifest.commands.map((c) => c.name.length), ...META_COMMANDS.map((m) => m.usage.length)) + 2;
  const routeWidth = Math.max(...manifest.commands.map((c) => `${c.method} ${c.path}`.length)) + 2;

  const row = (c: CliManifestCommand): string =>
    `  ${pad(c.name, nameWidth)}${pad(c.cost > 0 ? `${c.cost} cr` : 'free', 7)}${pad(`${c.method} ${c.path}`, routeWidth)}${truncate(c.summary, 70)}`;

  const lines: string[] = [];
  lines.push('Billable commands (credits per call)');
  for (const c of billable) lines.push(row(c));
  lines.push('');
  lines.push('Free commands');
  for (const c of free) lines.push(row(c));
  lines.push('');
  lines.push('Meta commands');
  for (const m of META_COMMANDS) lines.push(`  ${pad(m.usage, nameWidth)}${pad('', 7)}${pad('', routeWidth)}${m.summary}`);
  lines.push('');
  lines.push(`Run "viral-outliers help <command>" for flags. 1 credit = ${formatUsd(1)}. Docs: ${DOCS_URL}`);
  return `${lines.join('\n')}\n`;
}

export function renderGlobalHelp(manifest: CliManifest, version: string): string {
  const lines: string[] = [];
  lines.push(`viral-outliers ${version}: command-line access to the Viral Outliers API (${manifest.apiBase})`);
  lines.push('');
  lines.push('Usage: viral-outliers <command> [flags]');
  lines.push('');
  lines.push('Get started:');
  lines.push('  viral-outliers login --key so_live_...     save your API key (or set $' + manifest.envVar + ')');
  lines.push('  viral-outliers commands                    list every command with its cost');
  lines.push('  viral-outliers help search-outliers        flags for one command');
  lines.push('  viral-outliers search-outliers --query "cold plunge" --platforms tiktok --min-outlier-score 5');
  lines.push('  viral-outliers get-post <post-id> --no-include-visual-analysis');
  lines.push('  viral-outliers remix-post --url https://www.tiktok.com/@x/video/1 --target-niche "B2B SaaS" --wait');
  lines.push('');
  lines.push('Output: JSON on stdout (pretty on a terminal, single-line when piped or with --compact).');
  lines.push('Errors go to stderr as JSON. Billed calls print "credits: charged=N balance=M" on stderr.');
  lines.push('Exit codes: 0 ok, 1 error, 2 payment required, 3 rate limited, 4 auth, 5 usage.');
  lines.push('');
  lines.push('Global flags:');
  lines.push(renderGlobalFlags());
  lines.push('');
  lines.push(`Docs: ${DOCS_URL}`);
  return `${lines.join('\n')}\n`;
}

export function renderMetaHelp(meta: MetaCommand): string {
  return `${meta.name}\n  Usage: viral-outliers ${meta.usage}\n  ${meta.summary}\n\nGlobal flags:\n${renderGlobalFlags()}\n`;
}
