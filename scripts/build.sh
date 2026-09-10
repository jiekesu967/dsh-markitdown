#!/bin/bash
# Build src/ → lib/ for dsh-markitdown.
#
# Dependencies are resolved and linked by scripts/link-deps.mjs, which accepts
# either a DSH source checkout ($DSH_CHECKOUT) or an installed runtime
# ($DSH_RUNTIME). TypeScript comes from the project, then $DSH_TSC, then a
# .tools/typescript beside the workspace, then npx.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Linking build dependencies ==="
node scripts/link-deps.mjs

TSC="${DSH_TSC:-}"
if [ -z "$TSC" ]; then
  if [ -f "$ROOT/node_modules/typescript/bin/tsc" ]; then
    TSC="node $ROOT/node_modules/typescript/bin/tsc"
  elif [ -f "$ROOT/../.tools/ts/package/bin/tsc" ]; then
    TSC="node $ROOT/../.tools/ts/package/bin/tsc"
  elif [ -n "${DSH_CHECKOUT:-}" ] && [ -f "$DSH_CHECKOUT/node_modules/typescript/bin/tsc" ]; then
    TSC="node $DSH_CHECKOUT/node_modules/typescript/bin/tsc"
  else
    TSC="npx --yes typescript@5.9.2 tsc"
  fi
fi

echo "=== Compiling src → lib ==="
# shellcheck disable=SC2086
$TSC -p tsconfig.json
echo "=== Build complete ==="
