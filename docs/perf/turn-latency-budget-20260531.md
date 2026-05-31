# Maestro Turn Latency Budget - 2026-05-31

## Scope

This pass builds on the thin CLI launcher split by measuring the remaining command/turn path and landing a focused split:

- keep top-level `--help` and `--version` on the existing instant-exit path;
- route raw-args command families (`skill`, `update`, `init`, `hosted-runner`) through a tiny emitted command runtime before loading the bundled full runtime;
- keep the full runtime path when startup telemetry or beacon destinations are configured;
- coalesce low-bandwidth assistant message updates so the TUI renders on batch flush instead of every token update.

## Architecture Budget

| Path | Runtime Loaded | Built Size |
| --- | --- | ---: |
| `dist/cli.js` | thin launcher | 5,728 bytes |
| `dist/cli-command-runtime.js` | raw-args command dispatcher | 1,470 bytes |
| `dist/cli-runtime.js` | full CLI/TUI/agent runtime bundle | 7,251,393 bytes |

The important split is that command-owned help no longer imports `dist/cli-runtime.js` unless startup telemetry destinations require it.

## Measurements

Command: `node scripts/measure-turn-latency-budget.mjs --iterations 8 --json`

The harness sets `MAESTRO_SKIP_STARTUP_UPDATE=1`, `MAESTRO_INTERNAL_TELEMETRY_DISABLED=1`, and `EVALOPS_INTERNAL_TELEMETRY_DISABLED=1` so local runs are deterministic and do not depend on network update checks.

| Area | Baseline Median | After Median | Notes |
| --- | ---: | ---: | --- |
| `maestro --version` | 87.6 ms | 33.1 ms | top-level instant exit |
| `maestro --help` | 139.1 ms | 41.0 ms | top-level instant exit |
| `maestro skill --help` | 1,457.9 ms | 125.3 ms | command runtime split, 11.6x faster |
| `maestro update --help` | 1,409.1 ms | 40.8 ms | command runtime split, 34.5x faster |
| mock agent turn wall | 566.9 ms | 348.8 ms | process/runtime wall time; in-process query setup stayed small |
| query setup to `tools:prepared` | 2 ms | 1 ms | from `MAESTRO_QUERY_PROFILE=1` |
| session write/read, 500 entries | 2.8 ms | 1.7 ms | local JSONL path, no behavior change intended |
| trace normalize/export, 25 spans | 0.2 ms | 0.1 ms | excludes DB roundtrip; no local PostgreSQL configured |
| low-bandwidth UI render requests, 500 updates | 501 | 2 | render on start + batch flush instead of per update |

An earlier command-only sanity repeat under a noisy machine state measured `skill --help` at 536.2 ms and `update --help` at 175.1 ms over 10 iterations. The final full harness above is the recorded comparison.

## Follow-up: Prompt Assembly Slice

After the command-runtime split, the real turn-startup bottleneck moved to initial system prompt assembly. A scripted replay profile reached tools quickly, then spent most of startup scanning guarded workspace paths while building the prompt:

| Area | Before | After | Notes |
| --- | ---: | ---: | --- |
| startup `tools:prepared` checkpoint | 25 ms | 15 ms | `MAESTRO_STARTUP_PROFILE=1` scripted replay |
| startup `prompt:assembled` checkpoint | 1,733 ms | 72 ms | prompt assembly delta dropped from +1,708 ms to +55 ms |
| startup `exec:ready` checkpoint | 1,746 ms | 83 ms | real CLI replay path |
| direct `finalizeSystemPrompt` | 2,680 ms | 37 ms | single local timing on the repo worktree |
| harness `prompt_context.finalize` | n/a | 19.7 ms p50 / 34.3 ms p90 | new deterministic budget checkpoint, 8 iterations |
| harness `prompt_context.combined` | n/a | 20.0 ms p50 / 35.9 ms p90 | project-doc load + final prompt assembly |
| mock agent turn wall | 336.6 ms p50 / 728.9 ms p90 | 340.3 ms p50 / 366.2 ms p90 | unchanged within noise; mock flow uses an empty system prompt |
| low-bandwidth render requests, 500 updates | 2 p50 / 2 p90 | 2 p50 / 2 p90 | verifies the #2387 coalescing behavior still holds |
| low-bandwidth render handle loop, 500 updates | 0.2 ms p50 / 0.8 ms p90 | 0.3 ms p50 / 0.8 ms p90 | no pane/render regression after the prompt scan change |

The guarded-workspace prompt still reports the same default category summary for representative protected paths (`.cursor`, `.windsurf`, `.idea`, `.amp`, `amp.json`, `.ssh`, `.gnupg`) and does not include concrete file paths or glob patterns.

## Release Guardrails

- `MAESTRO_BEACON_FILE=/tmp/... maestro skill --help` still falls through to the full runtime and writes a `cli.startup` beacon.
- `maestro context --help` and `maestro status --help` still print top-level help; the command runtime only owns raw-args command families that already preserve command-specific help.
- No package metadata or public dependency surface changed.
- The guarded-file enforcement path remains unchanged; this only replaces the prompt-time category summary scan.
- The public release mirror should pick up source changes normally; build output remains generated from `npm run build`.

## Verification

- `node ./scripts/run-vitest.js --run test/cli/system-prompt.test.ts test/prompts/system-prompt.test.ts`
- `node ./scripts/run-vitest.js --run test/cli-runtime.test.ts test/streaming-view.test.ts test/cli-tui/agent-event-router-thinking.test.ts test/cli/instant-exit.test.ts`
- `npm run build`
- `node scripts/measure-turn-latency-budget.mjs --iterations 8 --json`
- `MAESTRO_STARTUP_PROFILE=1 MAESTRO_QUERY_PROFILE=1 node dist/cli.js exec --replay test/fixtures/scripted-replay/basic-tool-call.json --tools read --json "Replay the CLI golden path."`
- `MAESTRO_BEACON_FILE=/tmp/... node dist/cli.js skill --help`
- `MAESTRO_SKIP_STARTUP_UPDATE=1 node dist/cli.js context --help`
- `MAESTRO_SKIP_STARTUP_UPDATE=1 node dist/cli.js status --help`
- `npm run verify-build`
- `npm run smoke`
- `npm run check:cli-runtime-conformance`
- `npm run check:release-surface`
- `node scripts/check-public-surface-boundary.mjs`
- `node scripts/validate-public-package-deps.js`
- `node scripts/check-runtime-deps.js`
