# Tool Call Speed Strategy Digest

The useful optimization was not single-tool execution. The existing transport
already handles all-read-only turns well. The gap was mixed turns: one mutating
tool in the batch held the whole turn to the low base concurrency, so independent
read-only inspections before and after the mutation were not launched as waves.
The Rust client had a parallel-tool request flag, but its native execution loop
still walked queued tool calls one at a time.

The accepted change keeps mutation boundaries deterministic:

- Read-only tool calls use the read-only concurrency limit.
- Pending read-only calls are drained before a mutating tool starts.
- Mutating tools run with concurrency 1.
- Later read-only calls wait for mutation completion, then run as their own wave.
- The Rust client now drains auto-approved read-only native calls through its
  existing bounded `BatchExecutor`, while approvals, bash, workflow-sensitive
  tools, and mutations stay serialized.

The live scripted-replay harness now sits at a median `tool_phase_ms` of about
187.5ms. Given fixed sleeps of 80ms + 20ms + 80ms, further scheduler work is
unlikely to produce material gains in this harness without weakening safety or
removing lifecycle checks.

After checking Hermes, the next useful improvements are not more concurrency in
this same harness. They are broader-system wins: exact-provenance MCP server
parallel opt-in, path-scoped mutation islands, per-batch tool metadata caches,
model prompt nudges that cause independent tools to be emitted in one response,
and cheaper Rust read-only task executors. The immediate safety regression found
by the full suite was also Hermes-shaped: cached read fast paths must not bypass
loop detection or reuse results after a mutation has completed earlier in the
same provider batch.
