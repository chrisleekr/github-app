#!/usr/bin/env bash
# Run each test file in its own Bun process to avoid mock.module() conflicts.
# Bun's mock.module() is process-global: mocks from one file bleed into others
# when all files run in a single process, causing import failures and segfaults.
set -uo pipefail
shopt -s globstar nullglob

passed=0
failed=0
failures=()

tests=(test/**/*.test.ts src/**/*.test.ts)
if (( ${#tests[@]} == 0 )); then
  echo "No test files matched test/**/*.test.ts or src/**/*.test.ts" >&2
  exit 1
fi

for f in "${tests[@]}"; do
  output=$(bun test "$f" 2>&1)
  has_zero_fail=false
  has_skip=false
  # Anchor on the leading-whitespace summary line Bun prints (e.g. " 0 fail")
  # so test names, echoed strings, or stack traces containing the literal
  # ' 0 fail' substring can't spuriously satisfy the success condition.
  if echo "$output" | grep -qE '^[[:space:]]+0 fail'; then
    has_zero_fail=true
  fi
  # Bun prints " N skip" (leading whitespace) only when N > 0. Treat any
  # non-zero skip as a failure so silently-skipped suites stop counting
  # as green: a fully-skipped suite trivially satisfies " 0 fail" but
  # exercises zero assertions, which previously masked DB-backed
  # integration tests when the test database was unreachable.
  if echo "$output" | grep -qE '^[[:space:]]+[1-9][0-9]* skip'; then
    has_skip=true
  fi
  if $has_zero_fail && ! $has_skip; then
    ((passed++))
  else
    ((failed++))
    failures+=("$f")
    if $has_zero_fail && $has_skip; then
      echo "FAIL (skipped tests present): $f"
    else
      echo "FAIL: $f"
    fi
    # Full output: module load failures don't emit '(fail)' lines, so a
    # filtered view would hide the root cause.
    echo "$output"
  fi
done

echo ""
echo "=== Test Summary ==="
echo "Files passed: $passed"
echo "Files failed: $failed"

if [ ${#failures[@]} -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "All tests passed."
