#!/usr/bin/env bash
set -euo pipefail

workspace_concurrency=${TEST_CI_WORKSPACE_CONCURRENCY:-4}

pnpm -r run --no-sort --workspace-concurrency "${workspace_concurrency}" test:ci
