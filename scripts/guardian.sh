#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist/guardian/cli.js"

if [[ -f "$DIST" ]]; then
	node "$DIST" "$@"
	exit $?
fi

if command -v npx >/dev/null 2>&1; then
	npx --yes tsx "$ROOT/src/guardian/cli.ts" "$@"
	exit $?
fi

echo "Composer Guardian requires either a built dist/guardian/cli.js or npx tsx." >&2
exit 1
