#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r --filter "./packages/*")
test_args=(--coverage --runInBand --reporter=json)
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

cmd=(pnpm "${pnpm_args[@]}" run --if-present test:ci)
if [[ ${#test_args[@]} -gt 0 ]]; then
  cmd+=(-- "${test_args[@]}")
fi

"${cmd[@]}"
