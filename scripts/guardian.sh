#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist/guardian/cli.js"

SRC_CLI="$ROOT/src/guardian/cli.ts"
SRC_RUNNER="$ROOT/src/guardian/runner.ts"
SRC_CONFIG="$ROOT/src/guardian/config.ts"
SRC_TYPES="$ROOT/src/guardian/types.ts"

use_dist=0
if [[ -f "$DIST" ]]; then
	# Prefer the built CLI only when it's newer than the source (avoids stale dist
	# causing false positives/negatives during local development).
	if [[ ! -f "$SRC_CLI" ]]; then
		use_dist=1
	elif [[ "$DIST" -nt "$SRC_CLI" && "$DIST" -nt "$SRC_RUNNER" && "$DIST" -nt "$SRC_CONFIG" && "$DIST" -nt "$SRC_TYPES" ]]; then
		use_dist=1
	fi
fi

if [[ "$use_dist" -eq 1 ]]; then
	node "$DIST" "$@"
	exit $?
fi

if command -v npx >/dev/null 2>&1; then
	npx --yes tsx "$ROOT/src/guardian/cli.ts" "$@"
	exit $?
fi

echo "Composer Guardian requires either a built dist/guardian/cli.js or npx tsx." >&2
exit 1
