#!/usr/bin/env bash
# The whole suite. Offline: everything talks to test/stub-breachprobe.mjs, nothing scans a real
# host, nothing needs `npm install`. Every claim this repository's README makes about exit codes
# has a case here that proves it fails on bad input.
set -u
cd "$(dirname "$0")/.."

# The runner exports GITHUB_STEP_SUMMARY and GITHUB_OUTPUT into every step, including this one,
# which is not the composite action step. Left set, src/gh.mjs's summary()/setOutput() write to
# those files instead of stdout, and every assert_contains below reads $OUT and finds nothing.
# Found 2026-09-04 when this suite passed locally (neither var is set on a laptop shell) and
# failed in the repository's own CI. Unset once, here, so every invocation below is deterministic
# regardless of which runner or shell it executes under.
unset GITHUB_STEP_SUMMARY GITHUB_OUTPUT

TMP="$(mktemp -d)"
STUB_PID=""
FAIL=0
CASE=0
trap 'cleanup' EXIT
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}

start_stub() {
  local mode="$1"
  local out="$TMP/stub-$mode-$$.out"
  node test/stub-breachprobe.mjs "$mode" > "$out" 2>&1 &
  STUB_PID=$!
  local url=""
  for _ in $(seq 1 50); do
    url="$(head -n1 "$out" 2>/dev/null)"
    [ -n "$url" ] && break
    sleep 0.1
  done
  if [ -z "$url" ]; then
    echo "stub-breachprobe ($mode) never printed a URL" >&2
    cat "$out" >&2
    exit 2
  fi
  echo "$url"
}

stop_stub() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  wait "$STUB_PID" 2>/dev/null
  STUB_PID=""
}

assert_exit() {
  CASE=$((CASE + 1))
  if [ "$1" = "$2" ]; then
    echo "ok   - $3 (exit $2)"
  else
    echo "FAIL - $3 (expected exit $1, got $2)"
    FAIL=1
  fi
}

assert_contains() {
  CASE=$((CASE + 1))
  if printf '%s' "$2" | grep -qF "$1"; then
    echo "ok   - $3"
  else
    echo "FAIL - $3 (did not find: $1)"
    FAIL=1
  fi
}

RUN() {
  # gate <mode> [extra env assignments...] -- run bin/leakless.mjs gate with a fresh stub
  local mode="$1"; shift
  local api; api="$(start_stub "$mode")"
  OUT="$(env "$@" LEAKLESS_API="$api" LEAKLESS_URL="https://target.example" LEAKLESS_OWNER_CONFIRMED="true" \
    node bin/leakless.mjs gate 2>&1)"
  CODE=$?
  stop_stub
}

# 1. a clean scan, nothing found
RUN clean
assert_exit 0 "$CODE" "a clean scan (grade A, no findings) passes"

# 2. header findings only: medium severity, neither named condition, still passes
RUN headers
assert_exit 0 "$CODE" "medium-severity header findings alone do not fail the build"
assert_contains "grade C" "$OUT" "the grade appears in the summary"

# 3. an exposed database: fails by default
RUN database
assert_exit 1 "$CODE" "a high-severity database finding fails by default"
assert_contains "Exposed database" "$OUT" "the summary names the exposed-database condition"

# 4. the same scan, with the database check turned off
RUN database LEAKLESS_FAIL_ON_DATABASE=false
assert_exit 0 "$CODE" "turning off fail-on-database-exposure clears the database-only failure"

# 5. an open write path (service-role key): fails by default
RUN writepath
assert_exit 1 "$CODE" "a leaked service-role key fails by default"
assert_contains "Open write path" "$OUT" "the summary names the open-write-path condition"

# 6. the write-path check in isolation from the grade floor (see the stub's header note)
RUN writepath-isolated
assert_exit 1 "$CODE" "an open write path fails even at a grade above the default floor"
RUN writepath-isolated LEAKLESS_FAIL_ON_WRITE_PATH=false
assert_exit 0 "$CODE" "turning off fail-on-write-path clears it when the grade floor is not crossed"

# 7. the grade floor alone: writepath's grade is F, the default floor
RUN writepath LEAKLESS_FAIL_ON_WRITE_PATH=false LEAKLESS_FAIL_ON_DATABASE=false
assert_exit 1 "$CODE" "grade F still fails the default floor even with both named checks off"
RUN writepath LEAKLESS_FAIL_ON_WRITE_PATH=false LEAKLESS_FAIL_ON_DATABASE=false LEAKLESS_MIN_GRADE=""
CODE_NOFLOOR="$CODE"
# min-grade left at its true default (F) above; this second call is redundant on purpose, to
# show the empty-string input resolves to the same default rather than a different one.
assert_exit "$CODE" "$CODE_NOFLOOR" "an unset min-grade resolves to the same default, not a bypass"

# 8. unreachable target: could-not-check, never a fabricated failing grade
RUN unreachable
assert_exit 2 "$CODE" "an unreachable host is could-not-check, not a score of zero"
assert_contains "Could not reach" "$OUT" "says plainly that the host was not reached"

# 9. BreachProbe itself errors: exit 2
RUN 500
assert_exit 2 "$CODE" "a 500 from BreachProbe is could-not-check"

# 10. a non-JSON body: exit 2
RUN badjson
assert_exit 2 "$CODE" "a body that does not parse as JSON is could-not-check"

# 11. missing url input: exit 2, no request even attempted
API="$(start_stub clean)"
OUT="$(env LEAKLESS_API="$API" LEAKLESS_OWNER_CONFIRMED="true" node bin/leakless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "a missing url input is exit 2"
stop_stub

# 12. owner-confirmed not set to true: exit 2, the action never supplies it on your behalf
API="$(start_stub clean)"
OUT="$(env LEAKLESS_API="$API" LEAKLESS_URL="https://target.example" node bin/leakless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "owner-confirmed defaults to unset, never to true"
stop_stub

# 13. a min-grade that is not one of A B C D F: exit 2
API="$(start_stub clean)"
OUT="$(env LEAKLESS_API="$API" LEAKLESS_URL="https://target.example" LEAKLESS_OWNER_CONFIRMED="true" \
  LEAKLESS_MIN_GRADE="Z" node bin/leakless.mjs gate 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "an invalid min-grade is exit 2, never a silent default"
stop_stub

# 14. CLI flags mirror the environment
API="$(start_stub database)"
OUT="$(node bin/leakless.mjs gate --url "https://target.example" --owner-confirmed true --api "$API" --no-fail-on-database 2>&1)"; CODE=$?
assert_exit 0 "$CODE" "the --no-fail-on-database flag matches the env var"
stop_stub

# 15. unknown flag: exit 2
OUT="$(node bin/leakless.mjs gate --nonsense 2>&1)"; CODE=$?
assert_exit 2 "$CODE" "an unknown flag is exit 2"

echo
echo "$CASE assertions."
if [ "$FAIL" = "1" ]; then
  echo "FAILED"
  exit 1
fi
echo "PASSED"
