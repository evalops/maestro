# Grok Build Parity Design Map

Audience: product and engineering leads deciding how EvalOps Maestro should
converge on **Grok Build-class** terminal agent UX without becoming an xAI-only
product or a source-level port.

**External reference (public product surface only):**
[xai-org/grok-build](https://github.com/xai-org/grok-build) ·
[docs.x.ai/build](https://docs.x.ai/build/overview)

**Maestro anchors:**
[Native TUI parity](../NATIVE_TUI_PARITY.md) ·
[TUI Architecture](../TUI_ARCHITECTURE.md) ·
[EvalOps Agent Core Parity](EVALOPS_AGENT_CORE_PARITY.md)

> **Hard rule:** This document maps *product outcomes* and *architecture
> shapes* observable from public docs and Maestro's own code. It does **not**
> authorize copying Grok Build source, reimplementing proprietary protocols
> from reverse-engineering, or trading away multi-provider / Platform
> governance. Treat Grok as a **quality bar**, not a monorepo to clone.

---

## 1. Goal & non-goals

### Goal

Make Maestro's interactive agent feel like a modern, native, full-screen coding
agent at Grok Build class:

- Fast, self-contained Rust TUI/runtime for day-to-day coding
- Structured **plan → approve → implement** workflow that reduces rework
- First-class **skills / plugins / hooks / MCP** extensibility with trust
- One-liner install, confident first run, and a numbered user guide
- Long-running work (background tasks, subagents) that stays visible and
  controllable
- Session chrome, compaction, and memory that survive multi-hour work

…while **keeping** EvalOps differentiators:

| Keep | Why |
|------|-----|
| Multi-surface Maestro | TUI, Web, VS Code, JetBrains, Slack, GitHub, Ambient, Conductor |
| Multi-provider models | Anthropic, OpenAI/Codex, Google, xAI, OpenRouter, Chinese providers, EvalOps routing |
| Platform governance | Approvals, audit, AgentRuntime, traces, meter, identity, evidence |
| Headless + hosted contracts | CI embedders, hosted runner, RPC, A2A fleet |
| Hermes-class Agent Core | Local-first skills + optional Platform attach ([EVALOPS_AGENT_CORE_PARITY.md](EVALOPS_AGENT_CORE_PARITY.md)) |

### Non-goals

1. **Do not become xAI-only.** Grok auth, `XAI_API_KEY`, and `grok-build` models
   may be supported providers, never the sole identity plane.
2. **Do not collapse Platform into the TUI.** Hosted governance, AgentRuntime,
   and multi-tenant audit stay on Platform; Maestro remains the agent core.
3. **Do not copy proprietary Grok code or internal monorepo layout.** Public
   crate names (`xai-grok-pager`, `xai-grok-shell`, …) are cited only as an
   external *shape* reference for a long-term crate split.
4. **Do not abandon TypeScript where it still owns product surfaces** (web
   server, contracts generation, complex CLI/evalops/mission paths) until a
   deliberate migration lands with tests.
5. **Do not reintroduce a TypeScript interactive TUI.** Interactive UX is
   native-only (`packages/tui-rs` / `maestro-tui`); see
   [TUI Architecture](../TUI_ARCHITECTURE.md).
6. **Do not require full monorepo purity** (100% Rust workspace, zero Bun/Nx)
   as a near-term gate. Crate split is a long-term track, not a release blocker
   for plan mode / plugins / install UX.

---

## 2. Current state vs Grok (Present / Partial / Open)

Statuses mirror [NATIVE_TUI_PARITY.md](../NATIVE_TUI_PARITY.md):

| Status | Meaning |
|--------|---------|
| **Present** | Usable product surface in Maestro with clear ownership |
| **Partial** | Core path exists; depth, UX, or policy differs from the Grok-class bar |
| **Open** | Not productized, or only adjacent building blocks exist |

### 2.1 Product / UX matrix

| Capability (Grok-class) | Maestro today | Status | Notes |
|-------------------------|---------------|--------|-------|
| Full-screen native TUI | `packages/tui-rs` (`maestro-tui`); TS TUI removed (#2891) | **Present** | ratatui + standalone agent loop |
| Trailing interactive prompt | `maestro "…"` → native TUI | **Present** | Grok-style handoff; `--mode text\|json` stays scripted |
| Worktrees | `--worktree[=name]` under `.maestro/worktrees/` | **Present** | Documented in [FEATURES.md](../FEATURES.md) |
| Skills as slash commands | `.maestro/skills`, prompts/commands dirs | **Present** | Built-ins win on collision |
| Session resume / continue / fork / rewind | JSONL sessions, `/new`, `/fork`, `/rewind` | **Present** | See [SESSIONS.md](../SESSIONS.md) |
| Approvals + sandbox + firewall | YOLO / Selective / Safe; Seatbelt / Landlock | **Present** | [SAFETY.md](../SAFETY.md) |
| MCP (stdio / HTTP / SSE) | `packages/tui-rs/src/mcp/` | **Present** | `/mcp`; project + user config |
| Hooks (native / Lua / WASM) | `packages/tui-rs/src/hooks/` | **Present** | WASM depth still partial |
| Background tasks | `tools/background_tasks.rs` + slash | **Present** | Logs under `~/.maestro/logs` |
| Prompt queue / steer | Follow-up + steer queues | **Present** | [PROMPT_QUEUE.md](../PROMPT_QUEUE.md) |
| Context compaction | Auto ~0.85 threshold | **Present** | Inspired by Grok-class thresholds; not identical policy |
| Modes cycle (Normal / Plan / Always-approve) | Shift+Tab + `/plan` | **Partial** | Mode chrome exists; plan depth is weaker (below) |
| Plan mode (deep) | Todo gate before mutating tools | **Partial** | No durable `plan.md`, no enter/exit plan tools, no plan-approval UI with line comments |
| Subagents / personas | Agents CLI, swarm/A2A, planner type | **Partial** | Parallel/agent surfaces exist; not a unified persona + marketplace story |
| Cross-session memory | Shared memory + `maestro memory` inspect | **Partial** | No dream/flush consolidation UX or hybrid FTS+vector product path |
| Config story | JSON + TOML mix (`~/.maestro/*`, legacy composer) | **Partial** | Native reads `config.toml` in places; public story still multi-format |
| Plugins + marketplace | Skills + MCP + hooks separately | **Open** | No installable plugin unit, no marketplace tab, no trust-scoped plugin dir |
| ACP (Agent Client Protocol) | IDE extensions own their protocols | **Open** | No first-class ACP server for arbitrary editors |
| One-liner install | Release binaries + npm + Nix | **Partial** | Manual curl-to-binary; no polished `install.sh` PATH installer UX |
| First-run auth UX | Multi-provider login (Codex, keys, EvalOps) | **Partial** | Powerful but not a single guided browser-first path |
| Numbered user guide | Docs index + FEATURES + QUICKSTART | **Partial** | Excellent contributor docs; not a 01–N progressive user guide |
| In-product dashboard / usage | Cost/status/value commands | **Partial** | Operator value reports exist; not a Grok-like usage dashboard product |
| Pure Rust crate split (pager/shell/tools/workspace) | Monolithic `maestro_tui` + TS monorepo | **Open** | Long-term architecture track |

### 2.2 Runtime / distribution matrix

| Area | Grok-class shape (public) | Maestro | Status |
|------|---------------------------|---------|--------|
| Interactive agent runtime | Pure Rust | Rust in `maestro-tui` | **Present** |
| Headless / print | Rust headless + streaming JSON | Native print path + TS headless protocol | **Partial** |
| Hosted remote runner | (product-specific) | `maestro-hosted-runner` + contracts | **Present** (Maestro-shaped) |
| CLI utilities in Rust | Single binary surface | skill, modes, agents, painter, anthropic, memory, init, openai, update, sessions, cost, status, hooks, export/import, hosted runner | **Partial** |
| Remaining TS CLI | n/a | `a2a`, `codex`, `config`, `context`, `evalops`, `mission`, `operating-plane`, `remote`, `run`, `scenario`, `value` | **Open** (migrate or deliberately keep) |
| Packaging | `install.sh` / `install.ps1` → `grok` | GitHub release assets, npm, Nix | **Partial** |
| Multi-surface web/IDE | ACP-focused | Web + VS Code + JetBrains + Slack + GitHub | **Present** (broader than Grok) |
| Platform attach | n/a (xAI cloud) | EvalOps Platform optional | **Present** (keep) |

### 2.3 Plan mode depth (detail)

| Grok-class behavior (public docs) | Maestro today |
|-----------------------------------|---------------|
| Agent may request `enter_plan_mode` (user-approved) | User/mode toggle only (`/plan`, Shift+Tab) |
| Read-only workspace except `plan.md` | Mutating tools blocked until a **todo/plan exists** (`require_plan`); not plan-file-scoped |
| Durable plan file in session dir | Todo store (session-oriented list, not reviewable `plan.md`) |
| `exit_plan_mode` → scrollable approval UI | No dedicated plan-exit approval surface |
| Line comments / request changes / quit plan | Not present |
| Always-approve stays armed under plan for non-edit tools | Plan mode forces Selective if YOLO was on; different policy composition |

**Parity target for Maestro:** adopt the *workflow outcomes* (explore → write
plan artifact → human approve → implement) using Maestro session paths,
Platform-safe audit events, and existing approval chrome — not Grok's internal
tool names or storage layout.

---

## 3. Priority tracks & acceptance criteria

Tracks are ordered for product leverage, not pure engineering purity.

### Track A — Plan mode deepen (P0)

**Intent:** Make planning a first-class, reviewable gate before high-blast-radius
implementation work.

**Build (outcomes):**

1. **Plan artifact** — durable markdown plan per session (e.g. under session
   storage, Maestro-owned path — not a copy of Grok's layout).
2. **Tooling** — agent-visible enter/exit (or equivalent) with approval hooks;
   while active, file edits limited to the plan artifact (bash write side-effects
   remain a documented residual risk until policy deepens).
3. **Approval UI** — scrollable plan preview with Approve / Request changes /
   Quit; optional inline comments that re-enter the agent as revision notes.
4. **Mode chrome** — keep Shift+Tab cycle; status badge `plan` while active;
   state survives restart where sensible.
5. **Compaction** — plan mode state + plan body survive `/compact`.

**Acceptance criteria:**

- [ ] User can enter plan mode via `/plan`, Shift+Tab, and (optionally) agent
      request with explicit user approval.
- [ ] While plan mode is active, mutating file tools against non-plan paths
      fail with a clear message naming the plan artifact.
- [ ] Agent can write/update the plan artifact without leaving plan mode.
- [ ] Exit presents a reviewable plan; Approve starts implementation mode;
      Request changes keeps plan mode and feeds comments into the next turn.
- [ ] Plan mode + plan body round-trip through session resume and compaction.
- [ ] Events/audit hooks emit product-safe plan lifecycle signals (local
      trajectory + optional Platform projection later).
- [ ] Docs: FEATURES + Tools Reference + user-guide section updated.

**Non-acceptance:** todo list alone as the only plan surface.

---

### Track B — Remaining Rust CLI (P1)

**Intent:** Finish the "native-first CLI" story so interactive *and* common
operator commands do not require Node agent bootstrap — without forcing every
EvalOps/Platform CLI into Rust on day one.

**Already native (baseline):** skill, modes, agents, painter, anthropic,
memory, init, openai, update, sessions, cost/stats/models/status, hooks,
export/import, hosted runner, headless/print paths.

**Still TypeScript (`src/cli/commands/`):**

| Command | Suggested disposition |
|---------|------------------------|
| `a2a` | Keep TS until fleet protocol freezes; optional thin native wrapper later |
| `codex` | Keep TS while app-server auth/package coupling is TS-owned |
| `config` | Candidate for native read/write against unified config schema |
| `context` | Candidate after context manifest ownership is clear |
| `evalops` | Keep TS (Platform attach) unless a thin native client is justified |
| `mission` | Product-owned; migrate only with mission runtime plan |
| `operating-plane` | Keep TS with Platform contracts |
| `remote` | Candidate after hosted-runner native surface absorbs attach UX |
| `run` | Inspect/ledger/promote: strong native candidate (Agent Core) |
| `scenario` | Eval harness; can stay TS |
| `value` | Candidate once value reports stabilize |

**Acceptance criteria:**

- [ ] Documented matrix of **native / TS / hybrid** commands in Tools Reference
      and this design doc (kept current).
- [ ] Any newly migrated command: no Node agent bootstrap on the happy path;
      exit codes and JSON flags preserved.
- [ ] CI smoke covers migrated commands on release binaries.
- [ ] No regression to Platform-only commands (`evalops`, operating-plane)
      without dual-path tests.

---

### Track C — Plugins system (P1/P2)

**Intent:** One installable unit that can ship skills + commands + hooks + MCP
(+ optional agents/LSP) with explicit **trust**, without replacing the skill
package format from [EVALOPS_AGENT_CORE_PARITY.md](EVALOPS_AGENT_CORE_PARITY.md).

**Shape (Maestro-native):**

```text
.maestro/plugins/<name>/
  plugin.json          # optional manifest
  skills/
  commands/
  hooks/
  mcp.json             # require includeTools (Agent Core rule)
  agents/              # optional
```

Discovery roots (illustrative): project `.maestro/plugins/`, user
`~/.maestro/plugins/`, config path list, CLI `--plugin-dir`.

**Trust model:** project plugins require explicit trust; user plugins trusted by
default; enabling ≠ running hooks/MCP until trusted.

**Marketplace (phase 2):** curated sources + install/update/list; SHA-pin policy
for enterprise. Prefer reusing skill linter patterns over inventing a second
package ecosystem.

**Acceptance criteria:**

- [ ] Plugin directory convention + optional `plugin.json` documented.
- [ ] Enabled plugin contributes skills/commands/hooks/MCP to one session.
- [ ] Trust gate blocks hooks/MCP from untrusted project plugins.
- [ ] `maestro plugin list|install|…` or equivalent native CLI surface.
- [ ] TUI extensions modal (or tabbed `/plugins` / `/skills` / `/mcp` / `/hooks`)
      for enable/disable/reload.
- [ ] Skill package format remains the progressive-disclosure unit inside
      plugins; no fork of SKILL.md semantics.
- [ ] Compatibility: continue reading Claude/Codex-ish paths only as *opt-in
      discovery*, never as a hard dependency.

---

### Track D — Install + first-run UX (P1)

**Intent:** Match the confidence of a one-liner install and a guided first
session, multi-provider style.

**Build:**

1. **`install.sh` / `install.ps1`** — detect OS/arch, fetch latest release
   binary, install to a user bin dir, update PATH instructions, print
   `maestro --version`.
2. **`maestro update`** — already native; wire installer and docs to it.
3. **First-run** — detect missing auth; offer browser login (Codex/EvalOps)
   *or* provider API key path; write config under `~/.maestro/`; show next
   prompt examples.
4. **Smoke** — installer CI job: install → `--version` → headless handshake.

**Acceptance criteria:**

- [ ] Documented one-liner for macOS/Linux and PowerShell path for Windows.
- [ ] Fresh machine (no prior `~/.maestro`) can reach an authenticated or
      API-key session in under five minutes following the guide.
- [ ] Installer does not require Bun/Node for the release-binary path.
- [ ] Failure modes (network, checksum, arch) print actionable errors.
- [ ] Public README install section points at the installer as primary.

---

### Track E — User guide docs (P1)

**Intent:** Progressive, numbered operator docs (Grok ships `01-…` through
`24-…` in-tree). Maestro already has deep design/protocol docs; operators need
a **story-shaped** path.

**Proposed tree (new, not a dump of design docs):**

```text
docs/user-guide/
  01-getting-started.md
  02-authentication.md
  03-keyboard-shortcuts.md
  04-slash-commands.md
  05-configuration.md
  06-theming.md
  07-mcp-servers.md
  08-skills.md
  09-plugins.md          # when Track C lands
  10-hooks.md
  11-models-and-providers.md
  12-project-rules.md    # AGENT.md / AGENTS.md
  13-memory.md
  14-headless-mode.md
  15-plan-mode.md
  16-subagents.md
  17-sessions.md
  18-sandbox-and-approvals.md
  19-background-tasks.md
  20-platform-attach.md  # EvalOps differentiator
  21-web-and-ide.md
  22-troubleshooting.md
```

**Acceptance criteria:**

- [ ] Numbered guides linked from [docs/README.md](../README.md) and root
      README "Docs" table.
- [ ] Each guide is task-oriented (commands the user can run) and links out to
      design docs for implementers.
- [ ] Plan mode, skills, install, and Platform attach have dedicated pages.
- [ ] No proprietary Grok text pasted; original Maestro prose.

---

### Track F — Architecture crate split (P2 / long-term)

**Intent:** Improve compile times, ownership boundaries, and test granularity
by splitting the monolithic `maestro_tui` crate along *runtime seams*, inspired
by the public Grok workspace layout (pager / shell / tools / workspace) — not
a rename contest.

**Candidate Maestro seams:**

| Crate (illustrative) | Responsibility |
|----------------------|----------------|
| `maestro-tui-app` | Event loop, widgets, slash dispatch, modals |
| `maestro-agent` | Turn loop, compaction, tool orchestration, protocol |
| `maestro-tools` | Built-in tools registry + implementations |
| `maestro-workspace` | FS, VCS, worktrees, checkpoints, path policy |
| `maestro-safety` | Firewall, approvals policy, sandbox glue |
| `maestro-mcp` / `maestro-hooks` / `maestro-skills` | Extension loaders |
| `maestro-session` | JSONL persistence, branching, export |
| `maestro-cli` bins | Composition roots (`maestro-tui`, hosted-runner) |

**Acceptance criteria (incremental):**

- [ ] No big-bang rewrite. Extract one seam with `cargo` boundaries and CI
      `cargo check -p` targets.
- [ ] Public API between crates is documented; cycles forbidden.
- [ ] Interactive latency and feature parity unchanged at each extraction.
- [ ] TS remains packaging/hand-off until Agent Core ledger / web migrations
      decide otherwise.

---

## 4. Sequencing recommendations

```text
Now          Plan deepen (A) ──┬── Installer + first-run (D)
                               ├── User guide skeleton (E)
                               └── CLI matrix doc + migrate `run`/`config` (B)

Next         Plugins v1 trust + load (C) ── Marketplace (C phase 2)
             Memory flush/dream productization (adjacent to A compaction)
             Remaining low-risk native CLI (B)

Later        ACP exploration (only if IDE partners need it)
             Crate split (F) behind compile-time pain
             Deeper bash write gating under plan mode
```

### Why this order

1. **Plan mode** is the largest interactive quality gap users feel mid-task.
2. **Install + guide** convert interest into successful first runs (Grok's
   public strength).
3. **Plugins** multiply skills/MCP without replacing Agent Core skill packages.
4. **CLI migration** is continuous hygiene; Platform-coupled commands stay TS.
5. **Crate split** pays off only after feature tracks stabilize ownership.

### Explicit deferrals

- Full Claude Code marketplace compatibility as a *primary* product goal
- Replacing Platform with any vendor cloud control plane
- 100% Rust for web UI or contracts generation
- Pixel-perfect Grok keyboard/theme cloning

---

## 5. Related Maestro docs

| Doc | Role |
|-----|------|
| [NATIVE_TUI_PARITY.md](../NATIVE_TUI_PARITY.md) | Feature checklist after TS TUI removal |
| [TUI_ARCHITECTURE.md](../TUI_ARCHITECTURE.md) | Native `maestro-tui` layout and launch paths |
| [EVALOPS_AGENT_CORE_PARITY.md](EVALOPS_AGENT_CORE_PARITY.md) | Hermes-class distribution + skill package contract |
| [FEATURES.md](../FEATURES.md) | User-facing TUI/CLI capabilities |
| [TOOLS_REFERENCE.md](../TOOLS_REFERENCE.md) | Slash commands and CLI flags |
| [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) | Compaction / token budgeting |
| [HOOKS_SYSTEM.md](HOOKS_SYSTEM.md) | Lifecycle hooks |
| [MCP_INTEGRATION.md](MCP_INTEGRATION.md) | MCP design |
| [ANY_AGENT_CONTROL_PLANE.md](ANY_AGENT_CONTROL_PLANE.md) | Platform multi-agent governance |
| [AGENT_RUNTIME_TASK_MAPPING.md](AGENT_RUNTIME_TASK_MAPPING.md) | Todos/background/swarm → Platform |
| [packages/tui-rs/ARCHITECTURE.md](../../packages/tui-rs/ARCHITECTURE.md) | In-crate architecture |

---

## 6. Working agreements

1. **Public sources only** for external comparison (README, user guide, product
   docs). No vendoring of Grok sources into Maestro.
2. **Name things for Maestro** (`plan.md` may exist as a concept; storage paths
   stay under `~/.maestro` / session manager conventions).
3. **Every track ships tests + docs** in the same PR train where practical.
4. **Update the status tables** in this file when a track lands so the map stays
   honest.
5. **Platform events** for new plan/plugin surfaces should reuse trajectory /
   pending-request / AgentRuntime mapping patterns rather than inventing a
   second audit language.

---

## 7. Changelog

| Date | Change |
|------|--------|
| 2026-07-20 | Initial design map: goals, gap table, tracks A–F, sequencing |

---

## Addendum 2026-07-24 — gap audit against xai-org/grok-build public tree

A full inventory pass compared Maestro against the public grok-build repo
(TUI guides, tools, workspace, ACP). Outcome:

**Shipped from this audit:**

- Slash-command prefix expansion on submit (`/qui` → `/quit`), ambiguity
  dropdown, edit-distance typo rescue, `tui.slash_command_fallback` config
  gate (#3047)
- Ghost-text inline completion rendered + Right/End accept (#3047)
- Double-Esc clear input, `@file:LINE` / `@file:START-END` mention
  expansion, `/loop <interval> <prompt>` scheduler, `/theme auto`
  (COLORFGBG) (#3050)
- Mouse click-to-select on the slash completion popup (this change)
- `maestro import-claude` — MCP + permissions import from Claude Code
  config (in flight)

**Confirmed open gaps (now tracked as issues):**

| Gap | Grok reference | Maestro anchors |
|-----|----------------|-----------------|
| File-level checkpoints + real `/rewind` | per-prompt file snapshots; rewind restores files, not just chat | checkpoint code lives in ambient daemon + headless resume only |
| ACP server (`agent stdio`) | Zed/Neovim/Emacs via Agent Client Protocol | headless RPC protocol `2026-04-02` is the substrate; ACP is an adapter |
| Subagent as a TUI tool (`spawn_subagent`) | first-class child transcripts, worktree isolation, resume chaining | swarm + control-plane dispatch exist; no Task-style tool in the TUI registry |

**Deliberately skipped:** media generation, voice dictation, Rhai
workflows (swarm DAG covers orchestration), pure-Rust Mermaid.
