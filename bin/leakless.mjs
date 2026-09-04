#!/usr/bin/env node
/* leakless. The dispatcher.
 *
 * The action calls this with no arguments and every input in the environment, which is the
 * `gate` path. The named subcommand exists so the same check can be run on a laptop, against the
 * same live BreachProbe, before anyone pushes.
 *
 * Exit codes are uniform and they are the point:
 *
 *   0  reachable, no exposed database and no open write path
 *   1  an exposed database, an open write path, or the grade floor was crossed
 *   2  the gate could not run. NOT a pass, and it never collapses into 0.
 *
 * There is no --force, no allowlist and no known-issues file. Each of those is a supported way to
 * record a failure and ship past it, which is the behaviour this exists to make impossible.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, '..', 'src', 'scan-gate.mjs');

const HELP = `
leakless. Scan a deployed URL with BreachProbe and fail the build on what a green test suite
cannot see: a database answering anonymous requests, or a credential that bypasses row-level
security entirely.

  leakless gate --url https://app.example.com --owner-confirmed true

Environment, which is how the action passes its inputs:

  LEAKLESS_URL                  the deployed URL to scan (required)
  LEAKLESS_OWNER_CONFIRMED      must be "true" (required): you own or are authorised to scan it
  LEAKLESS_MIN_GRADE            A, B, C, D or F; fail at or below this grade. Default F
  LEAKLESS_FAIL_ON_DATABASE     false to stop failing on an exposed database. Default true
  LEAKLESS_FAIL_ON_WRITE_PATH   false to stop failing on an open write path. Default true
  LEAKLESS_API                  BreachProbe base URL, default https://breachprobe.kynth.studio
  LEAKLESS_TIMEOUT              seconds before the run becomes exit 2, default 90

Exit codes:  0 clean  ·  1 exposed database, open write path, or below the grade floor  ·  2 could not check

One scan per run. BreachProbe publishes no rate policy to retry against, so this never retries
and never polls; a failed request is exit 2, not a second attempt.
`;

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'gate';
const rest = cmd === argv[0] ? argv.slice(1) : argv;

const FLAGS = {
  '--url': 'LEAKLESS_URL',
  '--owner-confirmed': 'LEAKLESS_OWNER_CONFIRMED',
  '--min-grade': 'LEAKLESS_MIN_GRADE',
  '--api': 'LEAKLESS_API',
  '--timeout': 'LEAKLESS_TIMEOUT',
};

if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

if (cmd !== 'gate') {
  console.error(`leakless: unknown command "${cmd}"`);
  console.log(HELP);
  process.exit(2);
}

const env = { ...process.env };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--no-fail-on-database') {
    env.LEAKLESS_FAIL_ON_DATABASE = 'false';
    continue;
  }
  if (a === '--no-fail-on-write-path') {
    env.LEAKLESS_FAIL_ON_WRITE_PATH = 'false';
    continue;
  }
  const key = FLAGS[a];
  if (!key) {
    console.error(`leakless: unknown flag "${a}"`);
    process.exit(2);
  }
  const v = rest[++i];
  if (v === undefined) {
    console.error(`leakless: ${a} needs a value`);
    process.exit(2);
  }
  env[key] = v;
}

const r = spawnSync(process.execPath, [GATE], { stdio: 'inherit', env });
/* A spawn that produced no status at all did not run the gate. That is could-not-check, so it is
 * 2 rather than the 0 a nullish default would hand back. */
process.exit(r.status ?? 2);
