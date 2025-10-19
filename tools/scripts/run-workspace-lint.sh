#!/usr/bin/env bash
set -euo pipefail

pnpm -r "$@" run --if-present lint
