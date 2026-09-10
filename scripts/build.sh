#!/bin/bash
# Thin wrapper over scripts/build.mjs, for callers that expect a shell entry
# point. The build itself is implemented in Node so it also runs on Windows and
# in environments where spawning a child process is not permitted.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/build.mjs" "$@"
