#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r)
benchmark_args=()
forward_to_benchmark=false

for arg in "$@"; do
  if [[ "$forward_to_benchmark" == "true" ]]; then
    benchmark_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "--" ]]; then
    forward_to_benchmark=true
    continue
  fi

  pnpm_args+=("$arg")
done

cmd=(pnpm "${pnpm_args[@]}" run --if-present benchmark)
if [[ ${#benchmark_args[@]} -gt 0 ]]; then
  cmd+=(-- "${benchmark_args[@]}")
fi

"${cmd[@]}"
