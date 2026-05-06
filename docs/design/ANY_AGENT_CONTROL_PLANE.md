# Any-Agent EvalOps Control Plane

This document reviews how EvalOps can make the control plane, registry, and
evidence loop work with any coding agent. It is intentionally broader than
Maestro, but it is written from the Maestro repository because Maestro already
contains the most complete reference integration.

The target product outcome is simple:

```text
agent starts
agent registers
agent discovers governed actions
agent runs or requests approval before risky work
agent emits traces and evidence
agent writes durable memory when it learns something useful
console shows a live, attributable agent session
```

The target engineering outcome is also simple: every supported agent should be
integrated through the same small EvalOps contract, even when the agent reaches
that contract through a different shim.

## Current Building Blocks

### Maestro

Maestro already has the strongest first-party reference path.

- `src/evalops/agent-bootstrap.ts`
  - logs in to EvalOps
  - creates or reuses a managed agent API key
  - connects to the Platform `agent-mcp` endpoint
  - calls `evalops_register`
  - runs `evalops_check_action` for the first governed inference check
  - calls `evalops_control_plane_summary`
  - stores `agentMcp` metadata for later CLI runs
- `src/evalops/managed-context.ts`
  - resolves token, org, workspace, user, agent, run, and session context
  - distinguishes "authenticated" from a real managed agent session
  - reports trace ingestion and evidence publishing only when the agent/run
    identity is present
- `src/mcp/platform-plugin.ts`
  - injects the EvalOps MCP endpoint as a plugin MCP server when configured
  - forwards workspace, session, agent, run, trace, request, scope, and surface
    headers
- `src/telemetry/maestro-event-bus.ts`
  - emits typed Maestro CloudEvents for sessions, tools, prompts, learned
    context, skills, evals, and safety events
- `packages/ambient-agent-rs/src/platform_event_bus.rs`
  - emits Rust Ambient Agent session and plan CloudEvents
  - now resolves the same managed org/workspace/user/run aliases as TypeScript
  - includes `evalops.context.v1` extensions on emitted CloudEvents

### Platform agent-mcp

Platform `agent-mcp` is the current universal control-plane edge.

- `GET /.well-known/evalops/agent-mcp.json`
  - advertises the Streamable HTTP MCP endpoint
  - advertises OAuth protected-resource metadata
  - documents the session header, examples, supported scopes, and tool catalog
- `POST /mcp`
  - accepts MCP initialize and `tools/call`
  - maintains a server-managed MCP session through `Mcp-Session-Id`
- `evalops_register`
  - creates an Identity-backed agent session
  - stores session state
  - best-effort registers the agent in Agent Registry
  - publishes lifecycle events
- `evalops_heartbeat`
  - keeps the Identity session and registry presence live
- `evalops_list_tools`
  - returns the static EvalOps catalog
  - merges configured proxy tools
  - merges declared session capabilities
  - filters availability through Governance when the session is registered
- `evalops_check_action`
  - classifies action risk locally
  - asks Governance to evaluate the action
  - creates approval requests for require-approval decisions
  - fails closed when governed policy cannot be evaluated
- `evalops_control_plane_summary`
  - returns the operator-ready proof object for the console empty state
  - includes session, metrics, agents, findings, policy controls, evidence,
    integrations, tools, feature flags, warnings, and recommended workflow
- `evalops_recall` and `evalops_store_memory`
  - bridge registered agent sessions into the memory service

The important point: `agent-mcp` is not only a tool server. It is the narrow
agent control-plane protocol for agents that already speak MCP.

### Platform Agent Registry

Agent Registry is the liveness and capability mesh. It owns agent presence,
heartbeat status, capabilities, surfaces, config delivery, and delegation state.
It does not own task execution or model routing.

The newer `agents.v1.AgentService` is the forward path. The older
`agentregistry.v1.AgentRegistryService` remains a deprecated compatibility
surface.

Agent Registry also projects active agent configs into the shared Registered
Artifact spine as `kind=agent` artifacts with capability, surface, budget, eval,
payload, lifecycle, and metadata references. That projection is the natural
place for the console to answer "what agents exist and what can they do?"

### Platform Traces

The traces service already supports the generic trace path that any agent can
use.

- `POST /v1/traces`
  - accepts OTLP HTTP trace export
  - supports protobuf and JSON forms
  - normalizes GenAI attributes into EvalOps spans and trace summaries
- `POST /v1/maestro/telemetry`
  - accepts Maestro event-shaped telemetry directly
  - converts events to trace spans and annotations

For any-agent support, OTLP is the lingua franca. Agent-specific shims should
prefer OTLP when possible, then fall back to event-bus CloudEvents or the
Maestro telemetry endpoint only when the agent cannot emit normal spans.

### Cerebro

Cerebro provides the durable working-memory and world-model substrate.

- The Agent SDK catalog exposes MCP tools for read, enforcement, and writeback.
- The world-model schema has first-class entities, sources, evidence,
  observations, claims, and bitemporal provenance.
- The useful writeback set for agents is:
  - `cerebro_observe`
  - `cerebro_claim`
  - `cerebro_decide`
  - `cerebro_outcome`
  - `cerebro_annotate`
  - `cerebro_report`
- The useful read set for agents is:
  - `cerebro_context`
  - `cerebro_graph_query`
  - `cerebro_timeline`
  - `cerebro_findings`
  - `cerebro_reconstruct`
  - `cerebro_templates`

For EvalOps, Cerebro is the long-term "working memory" layer, while Platform
memory and Maestro learned-context events are the immediate product path.

## External Standards And Client Reality

MCP is the broadest current compatibility layer for coding agents.

- The MCP 2025-06-18 authorization spec uses OAuth protected-resource metadata
  for HTTP server authorization discovery.
- Claude Code supports MCP server configuration and remote HTTP MCP servers.
- OpenAI Codex supports MCP servers in `~/.codex/config.toml` and CLI-managed
  MCP additions.
- Gemini CLI supports `mcpServers` in `settings.json`.
- Cursor supports MCP servers, including remote configurations.

OpenTelemetry is the broadest current compatibility layer for agent traces.
The GenAI semantic conventions define standard attributes such as provider,
request model, response model, usage input tokens, usage output tokens, and
cost. EvalOps should normalize these into first-class trace fields but keep
the original attributes available for debugging.

The conclusion is that EvalOps should not require every agent to embed a
Maestro SDK. The default integration should be:

1. MCP for control-plane tools.
2. OTLP for traces.
3. Agent Registry for liveness and capability presence.
4. Cerebro or Platform memory for durable knowledge.
5. Optional shims for agents that cannot call these directly.

## The Minimal Any-Agent Contract

Every integrated agent needs to satisfy this contract.

### Identity

Required:

- organization ID
- workspace ID, or an explicit statement that workspace equals organization
- user ID or service principal ID
- agent ID
- agent run ID
- session ID
- surface
- requested scopes

Recommended:

- agent run step ID for tool-level spans
- trace ID and traceparent
- request ID
- repository, branch, and commit when the agent is working in code

The same values should be carried in all paths:

- MCP headers
- OTLP attributes
- CloudEvent extensions
- tool execution metadata
- memory/writeback metadata

### Registration

An agent is not live until it can prove a registered session.

Minimum flow:

```text
initialize MCP session
call evalops_register
store agent_id, run_id, granted scopes, session expiration
start heartbeat loop
call evalops_list_tools
call evalops_control_plane_summary
```

Plain EvalOps login is only authentication. It must not imply that the current
process is a managed agent session.

### Capability Discovery

Each agent should expose capabilities in two forms:

- coarse capabilities for Agent Registry discovery, such as `code:read`,
  `code:write`, `shell:exec`, `browser:use`, `mcp:call`, `git:review`, or
  `deployment:apply`
- tool catalog entries for actual governable actions, using the
  `<service>.<object>.<action>` namespace convention used by `agent-mcp`

Declared-only capabilities are useful for inventory but should not be treated
as executable until they are hosted or proxied.

### Governance

Every mutating or high-risk action should go through a policy checkpoint before
execution.

Minimum preflight:

```json
{
  "action_type": "shell.exec",
  "action_payload": "kubectl apply -f deploy.yaml",
  "declared_risk_level": "high"
}
```

Possible decisions:

- `allow`: agent may execute
- `require_approval`: agent must wait or surface the approval request
- `deny`: agent must not execute

Important failure rule:

- observe-only integrations may fail open for telemetry writes
- governed integrations must fail closed before execution

### Trace Ingestion

Every agent run should create a trace tree. At minimum:

- root span: agent run
- child span: inference request
- child span: tool call
- child span: governance check
- child span: approval wait, when applicable
- child span: memory recall/store, when applicable

Recommended OTLP attributes:

```text
evalops.organization_id
evalops.workspace_id
enduser.id
agent.id
evalops.agent_run_id
evalops.agent_run_step_id
evalops.session_id
evalops.surface
gen_ai.provider.name
gen_ai.request.model
gen_ai.response.model
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.usage.cost_usd
```

Maestro and Rust Ambient Agent should continue to emit `evalops.context.v1`
CloudEvent extensions for event-bus consumers. Third-party shims can emit
OTLP first and CloudEvents only when they need audit-bus fanout.

### Evidence Event

The first-run proof must be a real artifact, not only "connected".

For a bootstrap flow, the evidence should prove:

- agent registered
- governed action catalog loaded
- at least one governance check ran
- trace ingestion accepted a span or event
- control-plane summary returned non-empty proof

This is what lets the console leave the empty state immediately.

### Durable Memory

Agents need two memory lanes:

- "recall" for previous facts, policies, decisions, and project context
- "writeback" for high-confidence observations, decisions, claims, and
  outcomes

The safe default is:

- read through `evalops_recall` or Cerebro read tools
- write only explicit facts through `evalops_store_memory` or
  `cerebro_claim` / `cerebro_observe`
- attach trace/run/session metadata on every write
- keep raw prompt transcripts out of long-term memory unless explicitly
  requested and policy allows it

## Shim Options

There is no single shim that fits every agent. We should support a small set of
integration profiles.

### Option 1: Native MCP Client

Use when the agent already supports remote MCP.

Examples:

- Claude Code
- OpenAI Codex
- Gemini CLI
- Cursor
- Windsurf or Cline-like clients

Shape:

```text
agent MCP client -> https://app.evalops.dev/mcp -> agent-mcp
```

Responsibilities:

- configure the remote EvalOps MCP server
- acquire or receive a bearer token
- call `evalops_register`
- call `evalops_check_action` before risky tools
- call `evalops_report_usage` after inference
- call `evalops_recall` / `evalops_store_memory` when appropriate

Strengths:

- fastest path to broad compatibility
- no local binary required if OAuth works
- keeps policy, auth, and tool catalog server-side

Weaknesses:

- most clients do not automatically preflight their built-in shell/edit tools
- trace coverage depends on client hooks or a separate telemetry shim
- approval UX varies by MCP host

Best use:

- provide governed EvalOps tools and memory to any MCP-capable agent
- use as the default onboarding path

### Option 2: Local MCP Sidecar

Use when the agent supports local MCP better than remote OAuth, or when we need
extra local context.

Shape:

```text
agent MCP client -> local evalops-agent-shim -> agent-mcp -> Platform services
```

Responsibilities:

- run as stdio or local Streamable HTTP
- own OAuth/device login if the host cannot
- call remote `agent-mcp`
- normalize headers and session IDs
- optionally enrich context with repository, branch, commit, and workspace root
- optionally emit OTLP spans for MCP calls

Strengths:

- works around inconsistent remote MCP support
- can be packaged as `evalops agent shim`
- can add local trace and environment context

Weaknesses:

- still cannot intercept built-in agent actions unless the host routes them
  through MCP or hooks
- adds another local process to manage

Best use:

- Claude/Cursor/Gemini/Codex setup where remote OAuth is painful
- early "works everywhere" integration while native clients mature

### Option 3: Command Wrapper Shim

Use when the agent is a CLI process and can be launched by EvalOps.

Shape:

```text
evalops agent run -- claude
evalops agent run -- codex
evalops agent run -- gemini
evalops agent run -- cursor-agent
```

Responsibilities:

- authenticate or load EvalOps credentials
- create/register an agent session
- export `MAESTRO_EVALOPS_*`, `MAESTRO_AGENT_*`, `TRACEPARENT`, and OTLP env
- start a heartbeat loop
- capture lifecycle, stdout/stderr summaries, and exit status
- emit root run spans and evidence

Strengths:

- works even when the agent has no native EvalOps support
- gives EvalOps a reliable lifecycle boundary
- can set shared environment variables for downstream tools

Weaknesses:

- cannot reliably govern internal tool calls unless the agent exposes hooks,
  MCP tool calls, or structured logs
- shell transcript capture is sensitive and must be summarized/redacted

Best use:

- baseline production tracking for arbitrary CLI agents
- CI, remote runner, and managed sandbox launches

### Option 4: Hook Shim

Use when the agent provides pre/post tool hooks.

Shape:

```text
agent built-in tool hook -> evalops preflight -> agent action -> evalops result
```

Responsibilities:

- map native action events to `evalops_check_action`
- block denied actions
- wait or surface approval-required decisions
- emit tool spans and tool results
- write observe-only records for low-risk actions

Strengths:

- strongest governance for non-Maestro agents
- can cover built-in shell/edit/browser actions
- keeps UX close to the host agent

Weaknesses:

- hook APIs are agent-specific
- prompt-injection and config trust boundaries vary by host

Best use:

- production-grade governance for specific high-value agents
- Claude Code hooks, Codex hooks if available, IDE command interception

### Option 5: Provider/API Proxy Shim

Use when the only reliable interception point is model inference.

Shape:

```text
agent provider client -> EvalOps-compatible provider endpoint -> llm-gateway
```

Responsibilities:

- proxy OpenAI-compatible, Anthropic-compatible, or Gemini-compatible requests
- strip provider prefixes when needed
- attach org/user/agent/run metadata
- emit inference spans, usage, cost, model, and provider facts
- optionally apply model policy before the request

Strengths:

- captures inference even for closed agent clients
- good for spend, model inventory, and trace roots

Weaknesses:

- does not govern local tools
- cannot see the full agent plan unless prompts are allowed and safe to store
- provider compatibility details are high-churn

Best use:

- spend and inference observability
- model governance
- pairing with another shim for action governance

### Option 6: Runtime SDK Adapter

Use when the agent is under our control or willing to embed a library.

Shape:

```text
agent runtime -> EvalOps SDK -> agent-mcp / traces / registry / Cerebro
```

Responsibilities:

- provide typed registration, heartbeat, tool preflight, trace, usage, and
  memory APIs
- expose a small TS/Rust/Python/Go contract
- keep schemas shared with Platform proto/OpenAPI contracts

Strengths:

- best developer experience for first-party and partner agents
- easiest to test end-to-end
- can preserve rich typed events

Weaknesses:

- slower ecosystem adoption than MCP
- every language needs maintenance

Best use:

- Maestro TS and Rust
- evalops/github-agent
- partner agents that want durable integration

### Option 7: MCP Firewall Proxy

Use when the agent needs third-party tools through EvalOps.

Shape:

```text
agent -> agent-mcp proxy tool -> mcp-firewall -> upstream MCP server
```

Responsibilities:

- declare external tool namespace, endpoint, risk, cost class, scopes, and
  provenance
- forward EvalOps agent token and session headers
- evaluate proxy tool availability through Governance
- record provenance for audit

Strengths:

- lets the control plane govern tools it does not host
- keeps integrations visible as `proxied` rather than hidden client config

Weaknesses:

- upstream result schemas still vary
- approval UX and long-running streams need careful handling

Best use:

- GitHub, Linear, browser, cloud, and other external action surfaces
- replacing ad hoc local MCP server sprawl with a governed tool catalog

## Recommended Integration Profiles

### Profile A: MCP-only

Minimum viable "any agent" profile.

Required:

- remote or sidecar MCP
- `evalops_register`
- `evalops_list_tools`
- `evalops_check_action`
- `evalops_control_plane_summary`

Optional:

- `evalops_recall`
- `evalops_store_memory`
- `evalops_report_usage`

Use for quick onboarding and ecosystem reach.

### Profile B: MCP plus OTLP

Production observability profile.

Adds:

- OTLP root span for each run
- child spans for inference, tool calls, governance, approvals, and memory
- `evalops.context.v1` identity attributes
- post-bootstrap trace proof

Use for agents where we need console liveness and trace drilldown.

### Profile C: Managed Runtime

Full EvalOps-managed profile.

Adds:

- command wrapper or managed launcher
- environment injection
- heartbeat supervision
- run/session lifecycle events
- governed tool hooks when available
- failure/exit evidence

Use for hosted runner, remote runner, and production use where EvalOps is
responsible for the runtime boundary.

### Profile D: SDK-integrated

Best first-party profile.

Adds:

- typed registration and heartbeat client
- typed tool preflight/resume client
- typed trace and CloudEvent publishers
- typed memory and Cerebro writeback helpers
- conformance tests

Use for Maestro TS, Maestro Rust, and any partner willing to embed the SDK.

## Agent Compatibility Matrix

| Agent family | First shim | Better shim | Hard problem |
| --- | --- | --- | --- |
| Maestro TS | SDK-integrated | Managed Runtime | Keep local login distinct from managed session |
| Maestro Rust Ambient Agent | SDK-integrated | Managed Runtime | Keep TS/Rust context and CloudEvent parity |
| OpenAI Codex CLI | Native MCP Client | Command Wrapper plus OTLP | Built-in tool preflight coverage |
| Claude Code | Native MCP Client | Hook Shim plus OTLP | Hook trust and approval UX |
| Gemini CLI | Native MCP Client | Command Wrapper plus OTLP | Auth and tool interception consistency |
| Cursor | Native MCP Client | Local MCP Sidecar | IDE-local actions outside MCP |
| Cline/Windsurf-style agents | Native MCP Client | Local MCP Sidecar | Per-host config and approval behavior |
| CI automation agent | Command Wrapper | SDK-integrated | Non-interactive approval and token rotation |
| GitHub issue/PR agent | SDK-integrated | Managed Runtime | Linking runs to issue/PR evidence |
| Closed SaaS agent | Provider/API Proxy | External webhook bridge | Missing local tool visibility |

## Registry Shape We Need

Agent Registry should continue to own liveness, but the control plane needs a
clearer integration profile around each registered agent.

Proposed profile fields:

```text
agent_id
organization_id
workspace_id
agent_type
surface
integration_profile
shim_type
runtime_owner
capabilities
tool_catalog_refs
trace_mode
memory_mode
approval_mode
last_heartbeat_at
last_trace_id
last_evidence_event_id
registered_artifact_id
```

Possible `integration_profile` values:

- `mcp_only`
- `mcp_otlp`
- `managed_runtime`
- `sdk_integrated`
- `provider_proxy`

Possible `shim_type` values:

- `native_mcp`
- `local_mcp_sidecar`
- `command_wrapper`
- `hook`
- `provider_proxy`
- `sdk`
- `mcp_firewall_proxy`

These values should show up in the console so the user can tell the difference
between "we can see this agent", "we can govern this agent", and "we can
reconstruct this agent's work".

## Control Plane Handshake

The durable bootstrap should be agent-neutral.

```text
1. Resolve EvalOps control-plane manifest.
2. Authenticate user or service principal.
3. Create or load an agent credential.
4. Initialize MCP session.
5. Register agent with agent_type, surface, capabilities, profile, and shim.
6. Start heartbeat.
7. Load governed tool catalog.
8. Run first governed inference/action check.
9. Emit trace/evidence proof.
10. Store local metadata so later runs preserve identity.
```

For Maestro, `maestro init` already performs most of this. For any agent, the
same sequence should live in a small `evalops-agent-bootstrap` package and be
used by shims.

## Evidence And Memory Model

The first evidence event should be normalized.

Suggested fields:

```text
event_type: evalops.agent.bootstrap.proof
organization_id
workspace_id
user_id
agent_id
agent_run_id
session_id
surface
integration_profile
shim_type
trace_id
governed_actions_loaded
governed_check_decision
approval_policy_state
risk_findings
registry_visible
memory_mode
created_at
```

For durable memory, use two levels:

- Operational memory: agent-scoped or project-scoped facts used by the next
  agent turn.
- World-model knowledge: Cerebro observations, claims, decisions, outcomes,
  and evidence with explicit provenance.

Promotion rule:

- A transient observation becomes durable memory only with evidence.
- Durable memory becomes a Cerebro claim only when the agent can state the
  subject, predicate, source, confidence, and evidence IDs.

## Security And Trust Boundaries

The main risk of "any agent" is not authentication. It is over-claiming control.

Do not label an agent "EvalOps managed" unless EvalOps owns the runtime launch
or has a registered agent session with run identity.

Control claims should be explicit:

- `authenticated`: EvalOps knows who the caller is
- `registered`: EvalOps has an active agent session
- `observable`: EvalOps receives traces or events
- `governed`: risky actions are preflighted before execution
- `managed`: EvalOps launched or supervises the runtime boundary
- `memory_writable`: agent may write durable facts

MCP tool exposure must stay scoped:

- anonymous traffic is dry-run only
- registered session required for governance, memory, meter, and proxy writes
- governed action failures fail closed
- observe-only telemetry failures fail open
- proxy tools must carry provenance tags

Hook and command-wrapper shims must treat local repo config as untrusted until
the user or policy approves it. A repo-provided hook should not be allowed to
turn on privileged EvalOps behavior before trust is established.

## Product UX

The console should describe exactly what is live.

Recommended empty-state handoff:

```text
Install an EvalOps agent connection

maestro init
evalops agent run -- codex
evalops agent shim claude --install
```

After bootstrap, the console should show:

```text
Registered agents: 1
Governable actions: 17
Trace ingestion: live
Evidence events: 1
Risk findings: 0
Policy coverage: starter policy active
Integration profile: managed_runtime
Shim: command_wrapper
```

The detail view should show:

- agent identity
- run/session identity
- profile and shim
- capabilities
- tool catalog and denied/proxied/declared-only status
- last heartbeat
- last trace
- evidence events
- memory permissions
- approval policy state

## Implementation Plan

### Phase 1: Package The Contract

Ship an agent-neutral bootstrap contract in Maestro or a small EvalOps package.

Deliverables:

- shared TypeScript bootstrap helper extracted from `agent-bootstrap.ts`
- JSON schema for bootstrap result and evidence proof
- CLI command shape for `evalops agent bootstrap` or `maestro agent bootstrap`
- tests with fake MCP client and fake trace sink

### Phase 2: Local Sidecar Shim

Build a stdio and local HTTP MCP sidecar that forwards to Platform `agent-mcp`.

Deliverables:

- `evalops-agent-shim mcp --stdio`
- `evalops-agent-shim mcp --http :PORT`
- OAuth/device login support
- remote manifest resolution
- register/list/check/summary smoke test
- install snippets for Claude, Codex, Gemini, Cursor

### Phase 3: Command Wrapper

Build `evalops agent run -- <command>`.

Deliverables:

- registration before launch
- heartbeat while child process is alive
- exported context environment
- OTLP root run span
- exit evidence event
- redacted stdout/stderr summary

### Phase 4: Hook Adapters

Add host-specific adapters for agents with pre/post tool hooks.

Deliverables:

- action mapper contract
- Claude Code hook adapter, if stable enough
- Codex hook adapter, if stable enough
- generic JSON hook adapter
- conformance fixture for allow, deny, approval, and unavailable policy

### Phase 5: Provider Proxy

Add provider-compatible proxy profiles for agents that cannot expose tools.

Deliverables:

- OpenAI-compatible profile
- Anthropic-compatible profile
- model prefix stripping at the proxy edge
- inference-only trace proof
- explicit console badge: "inference observable, tools not governed"

### Phase 6: Registry And Console

Make the integration profile visible.

Deliverables:

- Agent Registry profile/shim metadata fields
- `evalops_control_plane_summary` includes profile and shim
- console cards distinguish authenticated, registered, observable, governed,
  managed, and memory-writable
- acceptance tests for empty-state flip

## Validators

Every stage should have a standalone validator.

### Manifest Validator

```text
GET /.well-known/evalops/agent-mcp.json
assert protocol.endpoint ends with /mcp
assert auth metadata exists
assert tools include evalops_register and evalops_check_action
```

### MCP Session Validator

```text
initialize /mcp
persist Mcp-Session-Id
tools/list
tools/call evalops_list_tools
```

### Bootstrap Validator

```text
login or token available
create/reuse API key
evalops_register returns agent_id and run_id
evalops_list_tools returns non-empty catalog
evalops_check_action returns a decision
evalops_control_plane_summary returns evidence or proof warnings
```

### Registry Validator

```text
agent appears in Agent Registry
agent has expected surface and capabilities
heartbeat updates last_seen
deregister removes or tombstones presence
```

### Governance Validator

```text
low-risk action returns allow
high-risk action returns require_approval or deny
governance outage fails closed for governed mode
observe-only mode does not block local execution
```

### Trace Validator

```text
emit OTLP span with evalops context
POST /v1/traces accepts it
ListTraces finds it by org/user/workspace
console drilldown can render span tree
```

### Evidence Validator

```text
bootstrap publishes one evidence event
event includes agent_id, run_id, session_id, trace_id
console summary evidence count increments
```

### Memory Validator

```text
evalops_recall returns available=false or results, never anonymous data
evalops_store_memory requires registered session
cerebro_claim or cerebro_observe includes source_system, source_event_id,
confidence, observed_at, and trace/run metadata
```

### Proxy Tool Validator

```text
configured proxy appears as invocation_mode=proxied
declared-only gaps remain visible
proxy forwards EvalOps agent token and X-EvalOps-MCP-Session-Id
governance denial blocks upstream invocation
```

## Open Questions

1. Should the universal shim live in Maestro, Platform, or a new small
   `evalops-agent-shim` package?
2. Should Agent Registry store integration profile fields directly, or should
   they be only metadata on Registered Artifacts?
3. Should first evidence events be emitted through `agent-mcp`, traces, audit,
   or a dedicated evidence endpoint?
4. Which hook-capable agent should be the first production-grade governed
   non-Maestro adapter?
5. Should Cerebro world-model writes be exposed directly through `agent-mcp`,
   or should `agent-mcp` continue to expose simpler memory tools and proxy
   Cerebro's Agent SDK tools separately?

## Recommendation

Make MCP plus OTLP the default "any agent" contract, then layer shims by
control depth.

Priority order:

1. Keep Maestro TS/Rust as the conformance reference.
2. Package the bootstrap and evidence proof contract.
3. Build a local MCP sidecar for broad agent onboarding.
4. Build a command wrapper for managed lifecycle and trace proof.
5. Add hook adapters only for the highest-value clients.
6. Use provider proxy only for inference visibility, with clear console
   labeling that local tools are not governed.

This gives EvalOps broad reach without blurring control claims. An agent can be
authenticated, registered, observable, governed, managed, and memory-writable
independently, and the console can show exactly which promises are true.

## References

- Maestro managed context: `src/evalops/managed-context.ts`
- Maestro bootstrap: `src/evalops/agent-bootstrap.ts`
- Maestro Platform MCP plugin: `src/mcp/platform-plugin.ts`
- Maestro Rust event bus: `packages/ambient-agent-rs/src/platform_event_bus.rs`
- Platform agent-mcp docs:
  `evalops/platform:docs/services/agent-mcp/README.md`
- Platform Agent Registry docs:
  `evalops/platform:docs/services/agent-registry/README.md`
- Platform traces docs:
  `evalops/platform:docs/services/traces/README.md`
- Cerebro Agent SDK catalog:
  `evalops/cerebro:docs/AGENT_SDK_AUTOGEN.md`
- MCP authorization spec:
  `https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization`
- OpenTelemetry GenAI semantic conventions:
  `https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/`
- Claude Code MCP docs:
  `https://docs.anthropic.com/en/docs/claude-code/mcp`
- OpenAI Codex MCP configuration docs:
  `https://github.com/openai/codex/blob/main/docs/config.md`
- Gemini CLI MCP docs:
  `https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html`
- Cursor MCP docs:
  `https://docs.cursor.com/advanced/model-context-protocol`
