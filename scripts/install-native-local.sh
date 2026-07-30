#!/usr/bin/env bash
# Build the native Maestro CLI from this checkout and install into ~/.local/bin
# so `maestro` / `maestro-tui` resolve to the Rust binary (not the npm package).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${MAESTRO_INSTALL_PREFIX:-$HOME/.local/bin}"
PROFILE="${MAESTRO_CARGO_PROFILE:-release}"

mkdir -p "$PREFIX"
echo "Building maestro ($PROFILE) from $ROOT …"
(
  cd "$ROOT"
  cargo build -p maestro --profile "$PROFILE"
)

BIN="$ROOT/target/$PROFILE/maestro"
if [[ ! -x "$BIN" ]]; then
  # cargo --profile release writes to target/release
  BIN="$ROOT/target/release/maestro"
fi
if [[ ! -x "$BIN" ]]; then
  echo "error: built binary not found under target/" >&2
  exit 1
fi

install -m 755 "$BIN" "$PREFIX/maestro"
install -m 755 "$BIN" "$PREFIX/maestro-tui"
echo "Installed:"
echo "  $PREFIX/maestro"
echo "  $PREFIX/maestro-tui"
echo
echo "Ensure ~/.local/bin is first on PATH (before ~/.npm-global/bin)."
echo "Then: maestro doctor"
