#!/usr/bin/env bash
set -euo pipefail

# xpra appends Xvfb-style "-screen <n> <WxHxD>" args.
# Xorg does not understand those, so strip them before exec.
args=()
skip=0
for arg in "$@"; do
  if [[ "$skip" -gt 0 ]]; then
    skip=$((skip - 1))
    continue
  fi

  if [[ "$arg" == "-screen" ]]; then
    skip=2
    continue
  fi

  args+=("$arg")
done

exec /usr/bin/Xorg "${args[@]}" \
  -nolisten tcp \
  -noreset \
  +extension GLX \
  +extension RANDR \
  +extension RENDER \
  +extension Composite
