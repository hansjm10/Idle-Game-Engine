#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r)
lint_args=()
forward_to_lint=false

for arg in "$@"; do
  if [[ "$forward_to_lint" == "true" ]]; then
    lint_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "--" ]]; then
    forward_to_lint=true
    continue
  fi

  pnpm_args+=("$arg")
done

cmd=(pnpm "${pnpm_args[@]}" run --if-present lint)
if [[ ${#lint_args[@]} -gt 0 ]]; then
  cmd+=(-- "${lint_args[@]}")
fi

"${cmd[@]}"
