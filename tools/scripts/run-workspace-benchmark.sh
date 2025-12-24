#!/usr/bin/env bash
set -euo pipefail

pnpm_args=(-r)
benchmark_args=()
forward_to_benchmark=false

show_help() {
  cat <<'EOF'
Usage: pnpm benchmark [pnpm args] -- [benchmark args]

Examples:
  pnpm benchmark
  pnpm benchmark --filter @idle-engine/core
  pnpm benchmark -- --help
EOF
}

for arg in "$@"; do
  if [[ "$forward_to_benchmark" == "true" ]]; then
    benchmark_args+=("$arg")
    continue
  fi

  if [[ "$arg" == "-h" || "$arg" == "--help" ]]; then
    show_help
    exit 0
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
