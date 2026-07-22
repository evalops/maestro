# Profiling maestro-tui with magic-trace

[Jane Street magic-trace](https://github.com/janestreet/magic-trace) captures ~10ms of
**every control-flow event** via Intel Processor Trace (not sampling). Use it when
sampling profilers cannot resolve short stalls.

## Requirements

| Need | Notes |
|------|--------|
| Linux | macOS/Windows not supported |
| Intel Skylake+ | `grep intel_pt /proc/cpuinfo` |
| Bare metal | Most VMs hide Intel PT (some Proxmox/KVM hosts expose it) |
| `perf` | Kernel tools matching (or compatible with) the running kernel |
| Symbols | `cargo build --profile magic-trace` (unstripped, debug info) |

## Quick start (Linux Intel host)

```bash
# install magic-trace from GitHub releases into PATH
# install perf (linux-tools-*)

scripts/magic-trace-tui.sh check
scripts/magic-trace-tui.sh run -- --help

# interactive TUI
cargo build --profile magic-trace --manifest-path packages/tui-rs/Cargo.toml
./packages/tui-rs/target/magic-trace/maestro-tui &
scripts/magic-trace-tui.sh attach
# Ctrl+C magic-trace to snapshot → open .fxt.gz at https://magic-trace.org/
```

### In-TUI hooks

- `/magic-trace stop` — call `magic_trace_stop_indicator` (default trigger)
- `/magic-trace on` — snapshot once on next frame over budget
- `MAESTRO_MAGIC_TRACE_SLOW_FRAME=1` — enable slow-frame trigger at startup

### Complementary sampling

```bash
perf record -F 999 -g -p "$(pidof maestro-tui)" -- sleep 3
perf report --stdio --percent-limit 1
```

## Findings (2026-07-20, developer@dev-desktop — Intel Ultra 9 285H)

Host: Linux x86_64, `intel_pt` present, Proxmox kernel 7.0.14-5-pve (used
compatible `linux-tools` 6.8 generic `perf` successfully).

### Idle TUI render loop (before)

`perf record -F 999 -g -p <tui>` during idle showed stacks like:

```text
build_runtime_badges
  → is_musl_env / env probes
  → std::fs::read_dir / getdents64
  → ZFS readdir + AppArmor path_open
  → App::render → main loop
```

**Root cause:** status-bar env badges re-scanned `/lib*` **every frame**.

**Fix 1:** cache process-static env badges with `OnceLock` and avoid broad `/lib`
walks (`packages/tui-rs/src/runtime_badges.rs`).

### After badge cache — next hotspot

Idle frames still paid `ratatui::buffer::Buffer::diff` + `unicode_width` every
~50ms even when nothing changed.

**Fix 2 (dirty redraw):** paint only when state changed or the UI is busy
(spinners). Idle event poll stretches to 100ms; agent/MCP/config poll helpers
return a dirty bit (`packages/tui-rs/src/app.rs`).

### Idle after dirty redraw (2026-07-20 re-profile)

12s idle, `perf record -F 999 -g`:

| Metric | Before (badge FS + always paint) | After dirty redraw |
|--------|----------------------------------|--------------------|
| Samples in 12s @ 999Hz | hundreds / frame stacks | **~22** total |
| Top stacks | `read_dir` / `Buffer::diff` | `epoll_wait`, `clock_gettime` (event poll) |
| `Buffer::diff` in idle | dominant | **absent** |
| Idle CPU (`pidstat` 10s) | (busy frame loop) | **~0.2% avg** |

Steady-state idle is effectively sleeping in the input poll — the right place
for a TUI.

### Startup (`--help` ×5)

Dominated by Tokio multi-thread runtime spawn / `pthread_create` — expected for
a short-lived process; not a steady-state TUI issue.

## macOS note

Apple Silicon Macs cannot run magic-trace. Profile on `developer@dev-desktop`
(or any Linux Intel host with PT). Use SSH there when local `scripts/magic-trace-tui.sh check` fails.
