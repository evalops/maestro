# Perf baselines

Versioned per-platform JSON baselines for maestro-tui hot paths, adopted from
[xai-org/grok-build's pty-bench gate](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-pty-harness/benches/pty_baselines/README.md).

CI compares the current run against the matching platform file and flags any
scenario that regresses by more than 15% (`--threshold` overrides). The gate is
**advisory**: the `perf-baselines` workflow warns and fails open, and is not a
required status check.

File naming: `<platform>.json` where `<platform>` is `<os>-<arch>` —
`linux-x86_64`, `linux-aarch64`, `macos-aarch64`.

## Scenarios

| Scenario | Hot path |
| --- | --- |
| `session_read_full` | `SessionReader::read_file` over a ~2k-entry JSONL session |
| `session_read_header` | `SessionReader::read_header` fast-scan of the same session |
| `session_wire_roundtrip` | `SessionEntry` JSONL serialize + parse roundtrip |
| `execpolicy_eval` | `Policy::check` over 500 parsed commands |

## Running the bench

```
cargo run -p maestro-tui --release --locked --bin maestro-perf-bench
```

## Producing or refreshing a baseline

Run on a quiet machine of the target platform:

```
cargo run -p maestro-tui --release --locked --bin maestro-perf-bench -- \
  --write-baseline packages/tui-rs/benches/baselines/<platform>.json
```

A PR that intentionally shifts a hot path (either direction) must refresh the
affected baselines and include the `maestro-perf-bench` output from a clean
run in the PR body so reviewers can sanity-check the new numbers.

## Comparing against a baseline

```
cargo run -p maestro-tui --release --locked --bin maestro-perf-bench -- \
  --baseline packages/tui-rs/benches/baselines/<platform>.json
```

Exits 1 and prints the regressed scenarios when any slowdown exceeds the
threshold; a missing baseline file fails loudly with instructions. Scenarios
present on only one side are skipped.

## Notes

- Baselines are per-platform, not per-machine: numbers seeded on a fast dev
  box may drift on shared CI runners. That is tolerable while the gate is
  advisory; recalibrate with `--write-baseline` on representative hardware if
  the warnings get noisy.
- These scenarios are also covered by the binary's unit tests for the
  comparison logic (`cargo test -p maestro-tui --bin maestro-perf-bench`).
