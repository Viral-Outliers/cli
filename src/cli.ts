#!/usr/bin/env node
// Entry point: wires real stdio, env and fetch into run() and turns its
// result into the process exit code. All logic lives in run.ts so tests can
// inject dependencies and never touch the network.
import { createInterface } from 'node:readline/promises';
import { run } from './run';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return run(argv, {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    now: () => Date.now(),
    prompt,
  });
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
