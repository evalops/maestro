#!/usr/bin/env bash
# Profile maestro-tui with Jane Street magic-trace (Linux + Intel PT only).
# https://github.com/janestreet/magic-trace
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${MAESTRO_MAGIC_TRACE_OUT:-$PWD/magic-trace-out}"
MT="${MAGIC_TRACE_BIN:-$(command -v magic-trace || true)}"
PERF_BIN="${PERF_BIN:-$(command -v perf || true)}"

die() { echo "error: $*" >&2; exit 1; }

need_linux_intel() {
  [[ "$(uname -s)" == "Linux" ]] || die "magic-trace requires Linux (this host is $(uname -s))"
  grep -q intel_pt /proc/cpuinfo || die "CPU/kernel has no intel_pt (need Intel Skylake+ bare metal)"
  [[ -n "$MT" && -x "$MT" ]] || die "magic-trace not found; install from https://github.com/janestreet/magic-trace/releases"
  [[ -n "$PERF_BIN" && -x "$PERF_BIN" ]] || die "perf not found; install linux-tools for your kernel"
}

build_bin() {
  mkdir -p "$OUT_DIR"
  export RUSTFLAGS="${RUSTFLAGS:--C force-frame-pointers=yes}"
  (cd "$ROOT" && cargo build --profile magic-trace -p maestro-tui)
  BIN="$ROOT/target/magic-trace/maestro-tui"
  [[ -x "$BIN" ]] || die "missing $BIN"
  echo "$BIN"
}

cmd="${1:-help}"
case "$cmd" in
  check)
    need_linux_intel
    echo "ok: linux + intel_pt + magic-trace + perf"
    ;;
  build)
    need_linux_intel
    build_bin
    ;;
  run)
    need_linux_intel
    BIN=$(build_bin)
    shift || true
    mkdir -p "$OUT_DIR"
    OUT="$OUT_DIR/run-$(date +%Y%m%d-%H%M%S).fxt.gz"
    echo "tracing: $BIN $*"
    echo "output:  $OUT"
    sudo env PATH="$(dirname "$PERF_BIN"):$PATH" "$MT" run -multi-thread -o "$OUT" -- "$BIN" "$@"
    echo "open $OUT at https://magic-trace.org/"
    ;;
  attach)
    need_linux_intel
    PID="${2:-}"
    if [[ -z "$PID" ]]; then
      PID=$(pidof maestro-tui | awk '{print $1}')
    fi
    [[ -n "$PID" ]] || die "no maestro-tui pid; pass pid or start the TUI first"
    mkdir -p "$OUT_DIR"
    OUT="$OUT_DIR/attach-$(date +%Y%m%d-%H%M%S).fxt.gz"
    echo "attaching pid=$PID -> $OUT (Ctrl+C to snapshot)"
    sudo env PATH="$(dirname "$PERF_BIN"):$PATH" "$MT" attach -pid "$PID" -multi-thread -o "$OUT"
    echo "open $OUT at https://magic-trace.org/"
    ;;
  help|*)
    cat <<EOF
Usage: $0 {check|build|run|attach} [args]

  check   Verify Linux + intel_pt + tools
  build   cargo build --profile magic-trace (with frame pointers)
  run     magic-trace run -- maestro-tui [args]
  attach  magic-trace attach -pid \$(pidof maestro-tui)

Env:
  MAGIC_TRACE_BIN, PERF_BIN, MAESTRO_MAGIC_TRACE_OUT
  MAESTRO_MAGIC_TRACE_SLOW_FRAME=1  (in-process slow-frame stop indicator)

Requires: Linux, Intel PT, unstripped binary (profile magic-trace).
EOF
    ;;
esac
