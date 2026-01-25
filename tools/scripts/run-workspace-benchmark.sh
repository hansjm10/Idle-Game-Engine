#!/usr/bin/env bash
set -euo pipefail

node tools/scripts/run-workspace-script.mjs benchmark "$@"
