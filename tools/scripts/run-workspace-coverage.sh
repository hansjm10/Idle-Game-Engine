#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r)
test_args=()
forward_to_test=false

for arg in "$@"; do
  if [[ "$forward_to_test" == "true" ]]; then
    test_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "--" ]]; then
    forward_to_test=true
    continue
  fi

  pnpm_args+=("$arg")
done

cmd=(pnpm "${pnpm_args[@]}" run --if-present coverage)
if [[ ${#test_args[@]} -gt 0 ]]; then
  cmd+=(-- "${test_args[@]}")
fi

"${cmd[@]}"

# Vitest generates LCOV entries relative to each package root (e.g. "SF:src/index.ts").
# SonarCloud runs from the repository root, so those paths won't match scanned sources
# (e.g. "packages/core/src/index.ts") unless we normalize them.
node tools/scripts/normalize-lcov-paths.mjs --quiet
