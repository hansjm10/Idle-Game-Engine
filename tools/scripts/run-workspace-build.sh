#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r)
build_args=()
forward_to_build=false

for arg in "$@"; do
  if [[ "$forward_to_build" == "true" ]]; then
    build_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "--" ]]; then
    forward_to_build=true
    continue
  fi

  pnpm_args+=("$arg")
done

cmd=(pnpm "${pnpm_args[@]}" run --if-present build)
if [[ ${#build_args[@]} -gt 0 ]]; then
  cmd+=(-- "${build_args[@]}")
fi

"${cmd[@]}"
