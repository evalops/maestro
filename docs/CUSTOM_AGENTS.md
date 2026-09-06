# Governed Custom Agents

> **Status:** This document predates the Rust-only runtime migration (#3016, #3017, merged 2026-07-22), which deleted Maestro's TypeScript agent runtime and SDK. Agent orchestration now lives in `packages/tui-rs/src/agent/`; a Rust equivalent of the plugin agent API described below has not been verified. Some file paths below may be stale; they are kept for design context and updated only where a corresponding Rust module was confirmed.


Installed Maestro packages can prepare primary or subagent modes with the capability-scoped API exported from `src/agent/plugin-agent-api.ts`.

Declare agent resource directories in the package manifest. Each child directory is one statically discoverable agent and can be filtered like other package resources:

```json
{
  "keywords": ["maestro-package"],
  "maestro": { "agents": ["./agents"] }
}
```

For example, `agents/focused-reviewer/agent.json` supplies the static `key`, `label`, and `entry` metadata. Runtime registration must match that metadata before the agent becomes available.

```ts
const agents = createPluginAgentApi({
  policy: hostPolicy,
  metadata: discoveredAgentMetadata,
});

const reviewer = agents.createAgent({
  key: "focused-reviewer",
  label: "Focused reviewer",
  description: "Reviews a bounded change",
  systemPrompt: "Review the requested change and report actionable findings.",
  model: "anthropic/claude-sonnet-4-6",
  tools: ["read", "search"],
  budgets: { maxTurns: 10, maxToolCalls: 20, maxCostUsd: 5 },
  approvalMode: "fail",
  sandboxMode: "read-only",
});

agents.registerAgentMode({
  key: "focused-reviewer",
  label: "Focused reviewer",
  agent: reviewer,
  primary: true,
});
```

`tools: "all"` means every tool already allowed by the host policy, not every installed tool. Explicit tool lists, models, and all three budget limits must remain within the host policy. Approval and sandbox settings may be equal to or more restrictive than the host, never less restrictive.

Registration is atomic and requires a matching static metadata declaration. Duplicate names, metadata mismatches, foreign or forged handles, unknown tools, disallowed models, invalid budgets, and permission escalation are rejected without modifying the registry.

This API configures agent modes only. It does not add executable tools, UI extensions, raw process access, or authority beyond the package installation and host runtime policy. Extensions and MCP remain the supported executable-tool mechanisms.
