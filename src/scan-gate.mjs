#!/usr/bin/env node
/* The gate. Runs one BreachProbe scan against a deployed URL, prints the verdict and findings as
 * a job summary, and fails the job on an exposed database or an open write path.
 *
 * WHAT IT IS ACTUALLY FOR. A green build proves the code compiles and the tests it shipped with
 * pass. It says nothing about whether the deployed app leaks its own database to an anonymous
 * request, or shipped a service-role key into the browser bundle, which is a property of the
 * running system, not of the source. Nothing else in CI checks that, so this does.
 *
 * ⛔ THIS IS A VIEW OVER BREACHPROBE'S OWN SCORE AND CATEGORIES, NEVER A SECOND SCANNER. The
 * `score`, `grade`, `findings[].category` and `findings[].severity` fields are exactly what
 * `POST /api/scan` returns; this file never re-derives a verdict BreachProbe did not already
 * state. Read from src/lib/scan/{types,score,supabase,secrets}.ts on 2026-09-04:
 *
 *   category  'keys' | 'database' | 'rls' | 'headers' | 'auth'   (Category, types.ts)
 *   severity  'critical' | 'high' | 'medium' | 'low' | 'pass'    (Severity, types.ts)
 *   grade     'A'..'F', capped at 'F' by any critical finding, at 'C' by any high (score.ts)
 *
 * "AN EXPOSED DATABASE" is a `category: 'database'` finding at `critical` or `high` (id
 * `open-rest-tables`: real rows returned to an anonymous request because row-level security is
 * off, per supabase.ts). "AN OPEN WRITE PATH" is a finding whose id names a credential or a
 * broken policy that grants access RLS was supposed to gate: `supabase-service-role-key` and
 * `supabase-secret-key` (secrets.ts) bypass RLS entirely by design, and `rls-cross-tenant`
 * (rls.ts, via index.ts) means the policies governing who may act on a row are not enforcing
 * tenant isolation. Both booleans are independent inputs so either can be turned off without
 * losing the other, and `min-grade` is a coarser net underneath both.
 *
 * Exit codes, the same three deferless and stubless use:
 *   0  reachable, and nothing named below was found
 *   1  an exposed database, an open write path, or the grade floor was crossed
 *   2  the gate could not run: bad input, unreachable target, or a scan that never came back.
 *      Not a pass, and it never collapses into 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotate, summary, setOutput, fetchJson } from './gh.mjs';

const API = (process.env.LEAKLESS_API || 'https://breachprobe.thecompound.tech').replace(/\/+$/, '');
const URL_INPUT = (process.env.LEAKLESS_URL || '').trim();
const OWNER_CONFIRMED = (process.env.LEAKLESS_OWNER_CONFIRMED || '').trim().toLowerCase() === 'true';
const FAIL_ON_DATABASE = (process.env.LEAKLESS_FAIL_ON_DATABASE ?? 'true').toLowerCase() !== 'false';
const FAIL_ON_WRITE_PATH = (process.env.LEAKLESS_FAIL_ON_WRITE_PATH ?? 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Math.max(5, Number(process.env.LEAKLESS_TIMEOUT || 90)) * 1000;

// The ids that grant a write path RLS was supposed to be the only door to. See the header note.
const WRITE_PATH_IDS = new Set(['supabase-service-role-key', 'supabase-secret-key', 'rls-cross-tenant']);

const GRADE_ORDER = ['F', 'D', 'C', 'B', 'A']; // worst to best; index compares directly

function die(code, message) {
  annotate('error', { title: 'leakless' }, message);
  summary(`## leakless\n\n**Could not check.** ${message}\n`);
  process.exit(code);
}

function gradeInput(name, fallback) {
  const raw = (process.env[name] ?? '').trim().toUpperCase();
  if (raw === '') return fallback;
  if (!GRADE_ORDER.includes(raw)) {
    die(2, `${name}="${raw}" is not one of A, B, C, D, F.`);
  }
  return raw;
}

const MIN_GRADE = gradeInput('LEAKLESS_MIN_GRADE', 'F');

const run = async () => {
  if (!URL_INPUT) die(2, "The 'url' input is required: the deployed URL to scan.");
  if (!OWNER_CONFIRMED) {
    die(
      2,
      "The 'owner-confirmed' input must be 'true'. BreachProbe's /api/scan refuses a request " +
        "without this attestation, and this action will not supply it on your behalf: set " +
        '`owner-confirmed: true` in the workflow only for a URL you actually own or are ' +
        'authorised to scan.',
    );
  }

  // One request. No retry loop, no polling: a scan is a real probe against a live third party
  // (the target host, and BreachProbe's own backend), and BreachProbe's docs publish no rate
  // policy to retry against, so the only safe assumption is exactly one call per run.
  const res = await fetchJson(`${API}/api/scan`, {
    method: 'POST',
    body: { url: URL_INPUT, ownerConfirmed: true },
    timeoutMs: TIMEOUT_MS,
  }).catch((e) => ({ ok: false, status: 0, text: String(e?.message || e) }));

  if (!res.ok || !res.json) {
    die(
      2,
      `BreachProbe returned HTTP ${res.status} for ${API}/api/scan. ` +
        `${res.json?.error || (res.text || '').slice(0, 300)}`.trim(),
    );
  }

  const result = res.json;

  /* ⛔ UNREACHABLE IS NEVER 0/F. A host this run could not reach was not measured, so this is
   * could-not-check, the same rule BreachProbe's own ScanResult.score documents: null rather
   * than a fabricated failing grade. */
  if (!result.reachable) {
    setOutput('reachable', 'false');
    die(2, `Could not reach ${result.host || URL_INPUT}. ${result.summary || 'The scan never measured a live host.'}`);
  }

  const findings = Array.isArray(result.findings) ? result.findings : [];
  const databaseHits = FAIL_ON_DATABASE
    ? findings.filter((f) => f.category === 'database' && (f.severity === 'critical' || f.severity === 'high'))
    : [];
  const writePathHits = FAIL_ON_WRITE_PATH ? findings.filter((f) => WRITE_PATH_IDS.has(f.id)) : [];
  const gradeIdx = GRADE_ORDER.indexOf(result.grade);
  const minIdx = GRADE_ORDER.indexOf(MIN_GRADE);
  const belowFloor = gradeIdx !== -1 && gradeIdx <= minIdx;

  for (const f of findings) {
    const bad = databaseHits.includes(f) || writePathHits.includes(f);
    const level = f.severity === 'critical' || f.severity === 'high' ? (bad ? 'error' : 'warning') : 'notice';
    annotate(level, { title: `BreachProbe ${f.severity} - ${f.category}` }, `${f.title}. ${f.detail}`);
  }

  const rows = findings
    .map((f) => `| ${f.severity} | ${f.category} | ${f.title} |`)
    .join('\n');

  const reportUrl = result.scanId ? `${API}/report/${result.scanId}` : null;

  let md =
    `## leakless\n\n` +
    `Scanned \`${result.host}\`: **${result.score ?? '?'}/100, grade ${result.grade ?? '?'}**. ${result.summary || ''}\n\n`;

  if (findings.length) {
    md += `| Severity | Category | Finding |\n| --- | --- | --- |\n${rows}\n\n`;
  } else {
    md += `No findings. Every check BreachProbe ran came back clean.\n\n`;
  }

  if (databaseHits.length) {
    md += `**Exposed database:** ${databaseHits.map((f) => f.title).join('; ')}.\n\n`;
  }
  if (writePathHits.length) {
    md += `**Open write path:** ${writePathHits.map((f) => f.title).join('; ')}.\n\n`;
  }
  if (belowFloor) {
    md += `Grade ${result.grade} is at or below the floor of ${MIN_GRADE}.\n\n`;
  }
  if (result.rlsTeaser?.detail) {
    md += `${result.rlsTeaser.detail}\n\n`;
  }
  if (reportUrl) {
    md += `Full report: ${reportUrl}\n\n`;
  }
  md +=
    `<sub>Scanned live by [BreachProbe](https://breachprobe.thecompound.tech) against \`${result.host}\`, ` +
    `just now. leakless is built and used in production by [Compound Labs](https://thecompound.tech).</sub>\n`;

  summary(md);

  const reportPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'leakless-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));

  setOutput('reachable', 'true');
  setOutput('score', String(result.score ?? ''));
  setOutput('grade', String(result.grade ?? ''));
  setOutput('findings', String(findings.length));
  setOutput('report-url', reportUrl || '');
  setOutput('report-path', reportPath);

  const failing = databaseHits.length > 0 || writePathHits.length > 0 || belowFloor;
  console.log(
    `leakless: ${result.host} scored ${result.score ?? '?'}/100 (${result.grade ?? '?'}), ` +
      `${findings.length} finding(s), ${databaseHits.length} database exposure(s), ` +
      `${writePathHits.length} open write path(s).`,
  );
  process.exit(failing ? 1 : 0);
};

run().catch((e) => die(2, `leakless crashed: ${e?.stack || e}`));
