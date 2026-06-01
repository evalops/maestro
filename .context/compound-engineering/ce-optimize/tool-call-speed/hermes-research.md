# Hermes Research Notes

Source: live `gh` inspection of `NousResearch/hermes-agent` on 2026-05-21.

## What Hermes Actually Did

- `agent/tool_dispatch_helpers.py` has an explicit parallelism rules engine:
  `_PARALLEL_SAFE_TOOLS`, `_NEVER_PARALLEL_TOOLS`, `_PATH_SCOPED_TOOLS`, path
  overlap checks, and destructive terminal command heuristics.
- `agent/tool_executor.py` runs eligible batches through a bounded worker pool
  (`_MAX_TOOL_WORKERS = 8`), collects results in original tool-call order, and
  propagates callbacks, interrupt bits, and progress heartbeats into workers.
- `tools/mcp_tool.py` adds `supports_parallel_tool_calls: true` as a per-server
  opt-in. It records exact MCP tool-to-server provenance instead of relying on
  ambiguous sanitized-name prefixes.
- `model_tools.py` avoids repeated async runtime setup by keeping a persistent
  event loop for the main thread and a thread-local persistent loop for worker
  threads.
- PR #26129's "100x" performance story is mostly hot-path removal: cached tool
  discovery, memoized toolset resolution, batched SQLite writes, narrowed MCP
  reloads, fast-fail dead loopback endpoints, and lower delegate/parallel guard
  overhead. It is not a single scheduler trick.
- PR #1365 fixed provider parsing so all parallel tool calls survive model
  adapters instead of only the first call.

## Maestro Implications

Hermes parity in this branch:

| Hermes speedup pattern | Maestro status | Notes |
| --- | --- | --- |
| Classifier-driven parallel read-only batches | Ported | TS transport schedules read-only waves before and after serialized mutations. |
| Bounded worker pool / ordered results | Ported | TS uses the existing pending-execution queue; Rust uses `BatchExecutor` and emits results in original call order. |
| Provider parser preserves many tool calls | Already present | The scripted-replay/live transport path already executes all emitted calls; the regression test guards nine calls in one turn. |
| Guardrails still run around fast paths | Ported | Cached read reuse and loop-skip paths are disabled after a mutation completes in the current provider batch. |
| Per-batch stable metadata cache | Partially ported | The new scheduler caches tool definitions by name for classification; reusable-result key caching remains a follow-up. |
| MCP server exact-provenance parallel opt-in | Follow-up | Maestro still relies on per-tool annotations for this branch; server-level provenance needs a separate MCP bridge change. |
| Path-scoped mutation parallelism | Follow-up | Not safe to port until checkpoints, approvals, and cache invalidation semantics are designed together. |
| Persistent async runtime / hot-path removal | Follow-up | The current plateau is scheduler-bound by fixed sleeps; broader Rust executor and discovery caches should be measured separately. |

Good next plateau-breakers:

1. Add a Hermes-style MCP server opt-in for parallel-safe servers that do not
   provide trustworthy per-tool annotations. Record exact tool provenance; do
   not infer from name prefixes.
2. Add a path-scoped scheduler mode for disjoint file mutations. It should be a
   separate experiment because checkpoints, approvals, and cache invalidation
   semantics are riskier than read-only waves.
3. Add a zero-sleep microbenchmark for scheduler overhead. The current complex
   goal is dominated by fixed sleeps and has reached its theoretical floor.
4. Cache per-batch tool metadata and reusable-cache keys instead of repeatedly
   scanning the tool list. Hermes' biggest practical wins came from deleting
   repeated stable work.
5. Teach model-specific prompts to emit independent tool calls in one response
   when safe. Scheduler speed only helps if the model exposes a batch.
6. For Rust, avoid constructing a fresh `ToolExecutor` per read-only batch task
   where a cheaper read-only executor or shared immutable metadata can be used.

Rejected for this branch:

- Parallelizing arbitrary mutations. Hermes only permits this with explicit
  path-scope checks or server opt-in; Maestro needs its own checkpoint and
  approval-aware design before doing that.
- Broadly trusting MCP `readOnlyHint` alone as a server-level guarantee. Tool
  annotations are useful, but Hermes' exact-provenance server opt-in is the
  better model for servers with shared state.
