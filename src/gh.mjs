/* The GitHub Actions surface, written directly against the runner's own protocol.
 *
 * There is no `@actions/core` here and there is not going to be one. That package is 40-odd
 * transitive files to write four strings to stdout and append to two files, and a gate whose
 * install step can fail is a gate that can be skipped by an npm outage. Everything below is the
 * documented workflow-command protocol, which is stable, and a bare `node` can run it.
 *
 * Reference read 2026-09-04: the runner parses `::error file=...,line=...::message` on stdout,
 * reads `GITHUB_STEP_SUMMARY` as markdown, and reads `GITHUB_OUTPUT` as `key=value` (or a
 * heredoc for multi-line values). Same module as stubless's, kept as its own copy in this
 * repository because each action ships standalone with zero runtime dependencies, including
 * on each other.
 */
import fs from 'node:fs';
import os from 'node:os';

const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function command(kind, props, message) {
  const p = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${escProp(v)}`)
    .join(',');
  process.stdout.write(`::${kind}${p ? ' ' + p : ''}::${escData(message)}${os.EOL}`);
}

/** An annotation the runner renders on the file and line, and in the checks tab. Findings from a
 *  live scan carry no file or line, only a title, and that is a valid annotation. */
export const annotate = (level, { file, line, title } = {}, message) =>
  command(level, { file, line, title }, message);

export const notice = (props, message) => annotate('notice', props, message);
export const warning = (props, message) => annotate('warning', props, message);
export const error = (props, message) => annotate('error', props, message);

/** Append markdown to the job summary. A local run with no runner prints it instead, so the
 *  output is never invisible just because nobody is on GitHub. */
export function summary(markdown) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) {
    process.stdout.write(markdown.endsWith('\n') ? markdown : markdown + '\n');
    return;
  }
  fs.appendFileSync(f, markdown.endsWith('\n') ? markdown : markdown + '\n', 'utf8');
}

/** Set a step output. Multi-line values go through the heredoc form; the delimiter carries a
 *  random suffix because a value containing the delimiter would otherwise end the block early. */
export function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  const v = String(value ?? '');
  if (!f) {
    process.stdout.write(`output ${name}=${v.includes('\n') ? v.split('\n')[0] + ' ...' : v}${os.EOL}`);
    return;
  }
  if (v.includes('\n')) {
    const d = `leakless_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(f, `${name}<<${d}${os.EOL}${v}${os.EOL}${d}${os.EOL}`, 'utf8');
  } else {
    fs.appendFileSync(f, `${name}=${v}${os.EOL}`, 'utf8');
  }
}

/** A fetch with a hard deadline. A hung request must become exit 2, never a silent hang that the
 *  job's own six-hour timeout eventually kills with no output. */
export async function fetchJson(url, { method = 'GET', body, timeoutMs = 30000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'leakless (+https://github.com/kyisaiah47/leakless)',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* left null on purpose: a non-JSON body from an endpoint that promises JSON is a fact the
       * caller needs to report, not one to paper over with an empty object. */
    }
    return { ok: res.ok, status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}
