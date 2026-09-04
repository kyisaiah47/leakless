# AGENTS.md

Instructions for an AI coding agent working in this repository.

A GitHub Action that scans a deployed URL with BreachProbe and fails the build on an exposed
database or an open write path. Node 18 or newer, zero dependencies, ESM throughout.

## Overview

```
action.yml            the composite action: inputs, outputs, branding
bin/leakless.mjs       the dispatcher. Thin, and it owns the exit codes
src/scan-gate.mjs     the gate. Calls BreachProbe once, writes the summary, sets the outputs
src/gh.mjs            the runner protocol: annotations, job summary, step outputs
test/run.sh           the whole suite, offline, nothing to install
```

## Build, test, lint

There is no build step, no bundler and nothing to install.

```sh
npm test
node bin/leakless.mjs gate --url https://example.com --owner-confirmed true
git ls-files -z
npx leakless gate --help
```

`npm test` is the gate. It runs offline against a stub BreachProbe, so a clean clone can prove
every claim in the README with no network and no scan of a real host.

## Code style and conventions

ESM only. `import`, `node:` prefixed builtins, no `require`, no `__dirname`. Two space indent,
single quotes, semicolons. Comments carry provenance: a threshold, a finding id or a category
name says which file in BreachProbe's own source it was read from and when.

## Architecture

This is a view over BreachProbe's own `score`, `grade` and `findings[].category` fields, never a
second scanner. The "exposed database" and "open write path" checks name specific finding ids
and categories read from BreachProbe's `src/lib/scan/{types,score,supabase,secrets}.ts` on
2026-09-04, cited in `src/scan-gate.mjs`'s header comment. If BreachProbe adds a new finding that
should trip one of those two checks, the fix is to add its id or category there, sourced the same
way, never to invent a parallel scoring model in this repository.

## Never do these

- Never add a `--force`, `--skip`, `--allow` or `--no-verify` flag, an allowlist, an ignore file or
  a known issues file. Each is a supported way to record a failure and ship past it.
- Never let a failed fetch, an unreachable host or a bad input exit 0. Could not check is exit 2
  and never collapses into a pass.
- Never send `ownerConfirmed: true` unless the `owner-confirmed` input is the literal string
  `"true"`. That attestation belongs to whoever writes the workflow, not to this action.
- Never retry or poll a scan. BreachProbe publishes no rate policy to retry against; one request
  per run is the whole contract.
- Never add a runtime dependency. The CI workflow has no install step on purpose.
- Never make the test agree with a change. The tests are the specification.

## Tests

Every behaviour claimed in the README has a case in `test/run.sh` that proves it, including
several that prove a claimed condition FAILS on the input it is supposed to catch. A suite that
only proves the happy path leaves the actual claim unchecked.

## If you found a defect

Fix it in this change. The exceptions are narrow: it is genuinely destructive, or it needs a
product decision only a person can make. Out of the scope I was given is not one of them.
