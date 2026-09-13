// The dependency-injected runtime. cli.ts wires real stdio/fetch/env into
// run(); tests pass fakes. Nothing in here calls process.exit.
import { parseCommandArgs, parseGlobalArgs, type GlobalFlags } from './args';
import { UsageError } from './coerce';
import {
  deleteConfig,
  looksLikeApiKey,
  readConfig,
  resolveApiKey,
  writeConfig,
  configPath,
  type ConfigLocation,
  type EnvMap,
} from './config';
import { META_COMMANDS, renderCommandHelp, renderCommandsTable, renderGlobalHelp, renderMetaHelp } from './help';
import { findCommand, loadManifest, type CliManifest, type CliManifestCommand } from './manifest';
import {
  EXIT_AUTH,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  printCreditsLine,
  printError,
  printJson,
  printResponse,
  type OutputOptions,
  type Writer,
} from './output';
import {
  buildPlan,
  buildRequest,
  NetworkError,
  normalizeBaseUrl,
  sendRequest,
  type FetchLike,
  type RequestContext,
} from './request';
import { CLI_VERSION } from './version';
import { WAITABLE_COMMANDS, waitForCommand } from './wait';

export interface RunDeps {
  fetch: FetchLike;
  env: EnvMap;
  stdout: Writer;
  stderr: Writer;
  /** stdout is a terminal (pretty JSON). */
  isTTY: boolean;
  /** stdin is a terminal (login may prompt). */
  stdinIsTTY?: boolean;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  prompt?: (question: string) => Promise<string>;
  platform?: string;
  homedir?: string;
  /** Override the bundled manifest (tests). */
  manifest?: CliManifest;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function location(deps: RunDeps): ConfigLocation {
  return { env: deps.env, platform: deps.platform, homedir: deps.homedir };
}

function outputOptions(globals: Pick<GlobalFlags, 'compact' | 'quiet'>, deps: RunDeps): OutputOptions {
  return { stdout: deps.stdout, stderr: deps.stderr, isTTY: deps.isTTY, compact: globals.compact, quiet: globals.quiet };
}

function buildContext(globals: GlobalFlags, deps: RunDeps, manifest: CliManifest): RequestContext {
  const config = readConfig(location(deps));
  const resolved = resolveApiKey(globals.key, deps.env, manifest.envVar, config);
  if (resolved.key && !looksLikeApiKey(resolved.key) && !globals.quiet) {
    deps.stderr.write(
      `warning: the API key from ${resolved.source === 'flag' ? '--key' : resolved.source === 'env' ? `$${manifest.envVar}` : 'the config file'} does not start with so_live_; the server will probably reject it.\n`,
    );
  }
  const baseUrl = globals.baseUrl ?? config.baseUrl ?? manifest.apiBase;
  return { baseUrl: normalizeBaseUrl(baseUrl), apiKey: resolved.key, version: CLI_VERSION };
}

async function executeCommand(cmd: CliManifestCommand, argv: string[], deps: RunDeps, manifest: CliManifest): Promise<number> {
  const { globals, params } = parseCommandArgs(cmd, argv);
  if (globals.help) {
    deps.stdout.write(renderCommandHelp(cmd));
    return EXIT_OK;
  }
  if (globals.wait && !cmd.isAsync) {
    throw new UsageError(`--wait is only supported for asynchronous commands (${WAITABLE_COMMANDS.join(', ')})`);
  }

  const ctx = buildContext(globals, deps, manifest);
  const plan = buildRequest(cmd, params, ctx);
  const first = await sendRequest(plan, deps.fetch);
  const out = outputOptions(globals, deps);

  if (!globals.wait || !first.ok) return printResponse(first, out);

  // The submit was billed; show that now, the polled result prints at the end.
  printCreditsLine(first.headers, out);
  const outcome = await waitForCommand(cmd, first, params, plan, {
    send: (p) => sendRequest(p, deps.fetch),
    ctx,
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now,
    stderr: deps.stderr,
    quiet: globals.quiet,
    pollIntervalMs: globals.pollIntervalSeconds * 1000,
    timeoutMs: globals.timeoutSeconds * 1000,
  });
  if (outcome.type === 'response') return printResponse(outcome.response, out);
  printJson(outcome.value, out);
  return outcome.exitCode;
}

async function login(argv: string[], deps: RunDeps, manifest: CliManifest): Promise<number> {
  const { globals, positionals } = parseGlobalArgs('login', argv);
  if (globals.help) {
    deps.stdout.write(renderMetaHelp(META_COMMANDS[0]));
    return EXIT_OK;
  }
  if (positionals.length > 1) throw new UsageError('login takes at most one positional argument (the API key)');

  let key = globals.key ?? positionals[0];
  if (!key) {
    if (!deps.prompt || !deps.stdinIsTTY) {
      throw new UsageError('No terminal to prompt on. Pass the key explicitly: viral-outliers login --key so_live_...');
    }
    key = (await deps.prompt('Paste your Viral Outliers API key (https://viraloutliers.com/settings?tab=api-keys): ')).trim();
    if (!key) throw new UsageError('No API key entered; nothing saved.');
  }
  key = key.trim();
  if (!looksLikeApiKey(key) && !globals.quiet) {
    deps.stderr.write('warning: API keys start with so_live_; this one does not.\n');
  }

  const loc = location(deps);
  const existing = readConfig(loc);
  const baseUrl = normalizeBaseUrl(globals.baseUrl ?? existing.baseUrl ?? manifest.apiBase);
  const ctx: RequestContext = { baseUrl, apiKey: key, version: CLI_VERSION };
  const res = await sendRequest(buildPlan('GET', '/api/v1/credits', ctx), deps.fetch);
  const out = outputOptions(globals, deps);

  if (res.status === 401) {
    deps.stderr.write('API key rejected (HTTP 401). Nothing was saved. Create a key at https://viraloutliers.com/settings?tab=api-keys\n');
    return EXIT_AUTH;
  }
  if (!res.ok) return printError(res, out);

  const body = res.json && typeof res.json === 'object' ? (res.json as { balance?: unknown }) : {};
  const savedBaseUrl = globals.baseUrl ? normalizeBaseUrl(globals.baseUrl) : existing.baseUrl;
  const file = writeConfig(loc, { apiKey: key, ...(savedBaseUrl ? { baseUrl: savedBaseUrl } : {}) });
  deps.stdout.write(`Logged in. API key saved to ${file}\nCredit balance: ${body.balance ?? 'unknown'}\n`);
  return EXIT_OK;
}

function logout(argv: string[], deps: RunDeps): number {
  const { globals } = parseGlobalArgs('logout', argv);
  if (globals.help) {
    deps.stdout.write(renderMetaHelp(META_COMMANDS[1]));
    return EXIT_OK;
  }
  const loc = location(deps);
  const file = configPath(loc);
  if (deleteConfig(loc)) deps.stdout.write(`Removed ${file}\n`);
  else deps.stdout.write(`No saved API key (${file} does not exist)\n`);
  return EXIT_OK;
}

function help(argv: string[], deps: RunDeps, manifest: CliManifest): number {
  const target = argv.find((a) => !a.startsWith('-'));
  if (!target) {
    deps.stdout.write(renderGlobalHelp(manifest, CLI_VERSION));
    return EXIT_OK;
  }
  const cmd = findCommand(manifest, target === 'whoami' ? 'get-credit-balance' : target);
  if (cmd) {
    deps.stdout.write(renderCommandHelp(cmd));
    return EXIT_OK;
  }
  const meta = META_COMMANDS.find((m) => m.name === target);
  if (meta) {
    deps.stdout.write(renderMetaHelp(meta));
    return EXIT_OK;
  }
  throw new UsageError(`Unknown command "${target}"; run: viral-outliers commands`);
}

async function dispatch(argv: string[], deps: RunDeps): Promise<number> {
  const manifest = deps.manifest ?? loadManifest();
  const [first, ...rest] = argv;

  if (!first || first === '--help' || first === '-h') {
    deps.stdout.write(renderGlobalHelp(manifest, CLI_VERSION));
    return EXIT_OK;
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    deps.stdout.write(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }
  if (first === 'help') return help(rest, deps, manifest);
  if (first === 'commands') {
    const { globals } = parseGlobalArgs('commands', rest);
    deps.stdout.write(globals.help ? renderMetaHelp(META_COMMANDS[3]) : renderCommandsTable(manifest));
    return EXIT_OK;
  }
  if (first === 'login') return login(rest, deps, manifest);
  if (first === 'logout') return logout(rest, deps);

  const name = first === 'whoami' ? 'get-credit-balance' : first;
  const cmd = findCommand(manifest, name);
  if (!cmd) throw new UsageError(`Unknown command "${first}"; run: viral-outliers commands`);
  return executeCommand(cmd, rest, deps, manifest);
}

/** Runs the CLI and resolves to the process exit code. Never throws for expected failures. */
export async function run(argv: string[], deps: RunDeps): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof NetworkError) {
      deps.stderr.write(`${error.message}\n`);
      return EXIT_ERROR;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr.write(`Error: ${message}\n`);
    return EXIT_ERROR;
  }
}
