#!/usr/bin/env node
/* A stub BreachProbe, so the suite runs from a clean clone with no network and no scan of a real
 * host.
 *
 * ⛔ IT IS NOT A SECOND SCANNER AND MUST NEVER BECOME ONE. It returns canned results so the tests
 * can assert what the GATE does with a result. Whether BreachProbe's scoring or its scan engine
 * are right is BreachProbe's own job. The response shape is transcribed from a real
 * POST /api/scan against https://breachprobe.kynth.studio, read 2026-09-04 (see README): `url`,
 * `host`, `reachable`, `supabaseDetected`, `score`, `grade`, `counts`, `summary`, `scannedAt`,
 * `findings[]` of `{ id, category, severity, title, detail }`, `rlsTeaser`, and `scanId`.
 *
 *   node test/stub-breachprobe.mjs <mode>
 *
 * Prints the base URL on the first line of stdout, then serves until killed.
 */
import http from 'node:http';

const MODE = process.argv[2] || 'clean';

const BASE = {
  url: 'https://target.example/',
  host: 'target.example',
  reachable: true,
  supabaseDetected: true,
  scannedAt: new Date().toISOString(),
  rlsTeaser: null,
};

/* Some of these grade/severity pairs are not ones the real scoreFindings() in score.ts would
 * ever produce together (a critical finding always caps the grade at F there). They are still
 * schema-valid BreachProbe responses, and this suite uses that combination deliberately in the
 * "isolated write path" cases so a test can prove the fail-on-write-path flag does something on
 * its own, independent of the grade floor, which real scoring would otherwise always trip at
 * the same time. */
const RESULTS = {
  clean: {
    ...BASE, scanId: 'scan-clean', score: 96, grade: 'A',
    counts: { critical: 0, high: 0, medium: 0, low: 0, pass: 6 },
    summary: 'Clean on every check we ran. Solid for a shipped app.',
    findings: [],
  },
  headers: {
    ...BASE, scanId: 'scan-headers', score: 71, grade: 'C',
    counts: { critical: 0, high: 0, medium: 2, low: 0, pass: 4 },
    summary: 'A few hardening gaps. No open door we could walk through, but 2 things to tighten.',
    findings: [
      { id: 'missing-hsts', category: 'headers', severity: 'medium', title: 'No HTTPS enforcement (HSTS)', detail: 'Strict-Transport-Security is missing.' },
      { id: 'missing-csp', category: 'headers', severity: 'medium', title: 'No Content-Security-Policy', detail: 'There is no Content-Security-Policy.' },
    ],
  },
  database: {
    ...BASE, scanId: 'scan-database', score: 58, grade: 'C',
    counts: { critical: 0, high: 1, medium: 0, low: 0, pass: 5 },
    summary: 'Serious gaps found. 1 high-risk issue needs fixing before you can trust this app with real users.',
    findings: [
      { id: 'open-rest-tables', category: 'database', severity: 'high', title: '3 tables readable without logging in', detail: 'Row-level security is not enforcing who can read them.' },
    ],
  },
  writepath: {
    ...BASE, scanId: 'scan-writepath', score: 12, grade: 'F',
    counts: { critical: 1, high: 0, medium: 0, low: 0, pass: 3 },
    summary: 'Critical exposure found. 1 issue could let anyone read or damage your data right now.',
    findings: [
      { id: 'supabase-service-role-key', category: 'keys', severity: 'critical', title: 'Supabase service_role key shipped to the browser', detail: 'This key bypasses row-level security entirely.' },
    ],
  },
  // Isolated: a write-path finding at a grade the real scorer would never actually assign it.
  // See the header note.
  'writepath-isolated': {
    ...BASE, scanId: 'scan-writepath-isolated', score: 88, grade: 'B',
    counts: { critical: 1, high: 0, medium: 0, low: 0, pass: 6 },
    summary: 'Test fixture: isolates the write-path check from the grade floor.',
    findings: [
      { id: 'supabase-secret-key', category: 'keys', severity: 'critical', title: 'Supabase secret key shipped to the browser', detail: 'This key bypasses row-level security entirely.' },
    ],
  },
  unreachable: {
    url: 'https://nope.invalid/', host: 'nope.invalid', reachable: false, supabaseDetected: false,
    score: null, grade: null, counts: { critical: 0, high: 0, medium: 0, low: 0, pass: 0 },
    summary: 'Could not reach nope.invalid. Check the URL is public and live.',
    findings: [], rlsTeaser: null, scannedAt: new Date().toISOString(),
  },
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/scan' || req.method !== 'POST') {
    return send(res, 404, { error: 'no route' });
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (MODE === '500') return send(res, 500, { error: 'stub is down' });
    if (MODE === 'badjson') return send(res, 200, 'not json');

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
    if (!body.url) return send(res, 400, { error: 'Enter the URL of the app you want to scan.' });
    if (!body.ownerConfirmed) {
      return send(res, 400, { error: 'Please confirm you own or are authorised to scan this app.' });
    }

    const result = RESULTS[MODE] || RESULTS.clean;
    send(res, 200, result);
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
