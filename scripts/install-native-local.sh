#!/usr/bin/env bash
# Install a native local build without replacing its macOS Keychain identity.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${MAESTRO_INSTALL_PREFIX:-$HOME/.local/bin}"
PROFILE="${MAESTRO_CARGO_PROFILE:-release}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/platform-target}"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null || fail "Node is required for build tooling (not the installed CLI)."
macos=0
if [[ "$(uname -s)" == Darwin ]]; then
  macos=1
  authority="${MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY:-}"
  identities="$(security find-identity -v -p codesigning)"
  if [[ -z "$authority" ]]; then
    # Prefer the installed identity so adding a second certificate does not
    # silently move existing credentials to a different signing team.
    if [[ -f "$PREFIX/maestro" ]]; then
      authority="$(codesign -dv --verbose=4 "$PREFIX/maestro" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p' || true)"
    fi
    if [[ -z "$authority" ]]; then
      authority="$(printf '%s\n' "$identities" | sed -n 's/.*"\(Developer ID Application: .*\)".*/\1/p' | sort -u)"
    fi
  fi
  [[ -n "$authority" && "$authority" != *$'\n'* && "$authority" == 'Developer ID Application: '* ]] ||
    fail "Set MAESTRO_RELEASE_DEVELOPER_ID_AUTHORITY to one Developer ID Application identity. Use the signed release installer if no certificate is available."
  printf '%s\n' "$identities" | grep -Fq "\"$authority\"" ||
    fail "Configured Developer ID identity is unavailable; keeping the installed binary."
fi

mkdir -p "$PREFIX"
stage="$(mktemp -d "$PREFIX/.maestro-build.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
printf 'Building Deixic Code (%s) from %s\n' "$PROFILE" "$ROOT"
(
  cd "$ROOT"
  cargo build --locked -p maestro --profile "$PROFILE" --message-format=json-render-diagnostics
) > "$stage/build.jsonl"

# Cargo reports the actual executable for custom targets, shared target
# directories, and the dev profile (whose output directory is named debug).
BIN="$(node - "$stage/build.jsonl" <<'NODE'
const fs = require('node:fs');
const readline = require('node:readline');
(async () => {
  let binary;
  const lines = readline.createInterface({ input: fs.createReadStream(process.argv[2]), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const item = JSON.parse(line);
    if (item.reason === 'compiler-artifact' && item.target?.name === 'maestro' &&
        item.target.kind.includes('bin') && item.executable) binary = item.executable;
  }
  if (!binary) throw new Error('Cargo did not report a maestro executable');
  process.stdout.write(binary);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
)"
[[ -x "$BIN" ]] || fail "Cargo's reported executable is missing: $BIN"
install -m 755 "$BIN" "$stage/maestro"
if [[ "$macos" == 1 ]]; then
  # Keep the release identifier: changing it invalidates existing Keychain ACLs.
  codesign --force --identifier maestro --options runtime --timestamp --sign "$authority" "$stage/maestro"
  codesign --verify --strict --verbose=2 "$stage/maestro"
  details="$(codesign -dv --verbose=4 "$stage/maestro" 2>&1)"
  printf '%s\n' "$details" | grep -Fxq 'Identifier=maestro' || fail "Signing identifier changed"
  printf '%s\n' "$details" | grep -Fxq "Authority=$authority" || fail "Signing authority changed"
  team="$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p')"
  [[ "$team" =~ ^[A-Z0-9]{10}$ ]] || fail "Missing signing team"
  [[ -z "${MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER:-}" || "$team" == "$MAESTRO_RELEASE_DEVELOPER_ID_TEAM_IDENTIFIER" ]] ||
    fail "Signing team does not match the configured release identity"
fi

# Publish only after signing succeeds. Copying to each alias preserves the same
# embedded signature; never re-sign per filename or mutate Cargo's cache.
for name in maestro-tui deixic-code; do
  install -m 755 "$stage/maestro" "$stage/$name"
  mv -f "$stage/$name" "$PREFIX/$name"
done
mv -f "$stage/maestro" "$PREFIX/maestro"
printf 'Installed %s/deixic-code (aliases: maestro, maestro-tui).\n' "$PREFIX"
printf 'Put %s first on PATH, then run deixic-code doctor.\n' "$PREFIX"
