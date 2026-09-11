# leakless

[![gates](https://github.com/kyisaiah47/leakless/actions/workflows/ci.yml/badge.svg)](https://github.com/kyisaiah47/leakless/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

A GitHub Action that scans a deployed URL with [BreachProbe](https://breachprobe.thecompound.tech)
and fails the build on an exposed database or an open write path.

A green test suite proves the code you wrote compiles and does what its own tests expect. It says
nothing about whether the app you just deployed answers an anonymous request with real rows from
a table, or shipped a key that bypasses row-level security into the browser bundle. That is a
property of the running system, not of the source, and nothing else in CI checks it.

## What it looks like

Real output, `leakless gate --url https://example.com --owner-confirmed true` against the live
BreachProbe:

```
## leakless

Scanned `example.com`: **71/100, grade C**. A few hardening gaps. No open door we could walk
through, but 3 things to tighten.

| Severity | Category | Finding |
| --- | --- | --- |
| medium | headers | No HTTPS enforcement (HSTS) |
| medium | headers | App can be embedded in a hostile iframe (clickjacking) |
| medium | headers | No Content-Security-Policy |
| low | headers | MIME-type sniffing not disabled |
| low | headers | No Referrer-Policy |

The cross-tenant probe did not run. Everything above is real and was measured on your app — but
the database and row-level-security checks are Supabase-specific, and nothing here was scored as
if isolation had been tested and passed.

Full report: https://breachprobe.thecompound.tech/report/c7af1935-0d4b-4245-b282-c79a5858c2ab
```

Every finding here is `headers`, medium or low severity, so the job passes (exit 0): neither
named condition fired, and grade C does not cross the default floor. A finding with `category:
database` at high or critical severity, or a leaked service-role key, prints as a workflow
annotation on the run and fails the job.

## Usage

```yaml
name: breachprobe
on:
  deployment_status:
jobs:
  scan:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: kyisaiah47/leakless@v1
        with:
          url: ${{ github.event.deployment_status.target_url }}
          owner-confirmed: 'true'
```

Or against a fixed URL on a schedule:

```yaml
on:
  schedule:
    - cron: '0 6 * * *'
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: kyisaiah47/leakless@v1
        with:
          url: 'https://app.example.com'
          owner-confirmed: 'true'
```

### Inputs

| Name | Default | Meaning |
| --- | --- | --- |
| `url` | (required) | The deployed URL to scan. |
| `owner-confirmed` | (required) | Must be the literal string `true`. BreachProbe refuses the scan without this attestation, and this action never supplies it for you. Set it only for a URL you actually own or are authorised to scan. |
| `min-grade` | `F` | `A`, `B`, `C`, `D` or `F`. Fail when the scan grade is at or below this. |
| `fail-on-database-exposure` | `true` | Fail when a table returns real rows to an anonymous request. |
| `fail-on-write-path` | `true` | Fail on a credential that bypasses row-level security, or a policy that does not enforce tenant isolation. |
| `api` | `https://breachprobe.thecompound.tech` | BreachProbe base URL. Only change this to point at a local BreachProbe. |
| `timeout` | `90` | Seconds to wait on the scan before the run becomes exit 2. |

### Outputs

| Name | Meaning |
| --- | --- |
| `reachable` | Whether the scan could reach the URL at all. |
| `score` | The scan score, 0 to 100, empty when unreachable. |
| `grade` | The scan grade, A to F, empty when unreachable. |
| `findings` | How many findings the scan returned. |
| `report-url` | Link to the full BreachProbe report for this scan, when one was persisted. |
| `report-path` | Path to the full JSON response, under `RUNNER_TEMP`. |

## Exit codes

| | |
| --- | --- |
| `0` | reachable, and neither named condition was found |
| `1` | an exposed database, an open write path, or the grade floor was crossed |
| `2` | the gate could not run. Not a pass, and it never collapses into 0 |

`2` covers an unreachable target as much as a BreachProbe outage: a host this run could not reach
was not measured, so it is could-not-check, never a fabricated failing grade. That is the same
rule BreachProbe's own scan engine holds itself to (`score: null`, not `0`, for an unreachable
host).

## What counts as each named condition

This is a view over BreachProbe's own `score`, `grade` and `findings[].category` fields, never a
second scanner. Read from BreachProbe's `src/lib/scan/{types,score,supabase,secrets}.ts` on
2026-09-04:

- **An exposed database** is a `category: database` finding at `high` or `critical` severity: a
  real row came back from an anonymous request because row-level security is not enforcing who
  can read the table.
- **An open write path** is a leaked `service_role` or `secret` key (either bypasses row-level
  security entirely by design), or a row-level-security policy that does not enforce tenant
  isolation.
- **The grade floor** (`min-grade`, default `F`) is BreachProbe's own letter grade: any critical
  finding caps it at `F`, any high-severity finding caps it at `C`.

Each of the two named checks is its own input, so either can be turned off independently, and the
grade floor is a coarser net underneath both.

## Local use

```sh
npm i -D leakless
npx leakless gate --url https://example.com --owner-confirmed true
```

No build step, no bundler, zero runtime dependencies. Flags map onto the same environment
variables the action sets, so a local run and a CI run cannot diverge.

```
leakless gate --url URL --owner-confirmed true    scan once and fail below the floor
leakless gate --min-grade C ...                    fail at grade C or below instead of F only
leakless gate --no-fail-on-database ...            stop failing on an exposed database alone
leakless gate --no-fail-on-write-path ...          stop failing on an open write path alone
```

## Rate limits

One scan per run. BreachProbe publishes no rate policy for `/api/scan` to retry against, so this
never retries and never polls: a request that fails is exit 2, not a second attempt. If a
workflow needs to watch a URL continuously, schedule the workflow itself; do not loop this action
inside one job.

## Running the tests

```sh
git clone https://github.com/kyisaiah47/leakless && cd leakless
npm test
```

Nothing to install. `test/run.sh` runs entirely offline against `test/stub-breachprobe.mjs`, a
stub that returns canned scan results so the suite can assert what the gate does with a result.
Whether BreachProbe's own scan engine is right is BreachProbe's own test suite's job; this
repository has no scanning opinion of its own. Every exit code and every named condition this
README claims has a case that proves it fails on the input it is supposed to catch: an exposed
database, an open write path, an unreachable host, a BreachProbe outage, a non-JSON body, a
missing `url`, an unconfirmed owner, and an invalid `min-grade`.

## Honest limitations

- **This scans what is live right now**, not the code in the pull request. A scan against a
  preview deployment is only as current as that deployment.
- **The free scan does not run BreachProbe's authenticated cross-tenant probe.** It signs up no
  users and tests no policy beyond an anonymous read. A finding here is real; the absence of one
  is not proof the deeper, paid probe would also find nothing, and BreachProbe's own response
  says so on every scan (`rlsTeaser`).
- **One scan tells you about one URL at one moment.** It is not a substitute for BreachProbe's own
  monitoring, which this action does not attempt to replace.
- **The named conditions are exactly the ones stated above and no others.** A future BreachProbe
  finding class is not covered until its id or category is added here, sourced from BreachProbe's
  own code the same way the current ones are.

## Why it is called leakless

Same naming shape as [deferless](https://github.com/kyisaiah47/deferless) and
[stubless](https://github.com/kyisaiah47/stubless): the failure it exists to catch, named as the
thing this build never ships with again. No `--force`, no allowlist, no known-issues file.

## Licence

MIT. Built and used in production by [Compound Labs](https://thecompound.tech).
