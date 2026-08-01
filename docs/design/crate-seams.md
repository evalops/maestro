# Crate seam roadmap for packages/tui-rs

`packages/tui-rs/src` is 227,108 lines of Rust across 299 files (84.3% of the
227,108/269,352-line Rust `src` trees). It is a single Cargo crate containing the
agent loop, AI provider clients, sandbox, sessions, the headless
server, and the terminal UI. This document records the measured module
dependency graph, the hot-file overlap against the ~48 PRs open against this
repo on 2026-07-25, and the ordered extraction plan that follows from both.

**Status:** slice 1 (`maestro-ai`) shipped as
[#3148](https://github.com/evalops/maestro-internal/pull/3148) (merged
2026-07-26), landing exactly the shape measured and planned below. The
measurement and adjacency data in this document reflect the state of the
repo on 2026-07-25, before those extractions. The dependency-free execution
policy leaf is now shipped as `maestro-execpolicy`; the remaining slices are
still pending as described.

**Precision caveat on slices 2-4:** review found that this document's
per-slice prerequisite lists (the specific named cycles under
`maestro-exec`/`maestro-policy`/`maestro-session` below) were incomplete —
each named only the one or two cycles most visible from the top-level
summary table, not the full set of outbound edges the affected modules
actually have. The corrections inline below fix the specific errors found,
but a full, precise accounting of exactly which edges must be broken (or
which modules must be co-extracted) for each slice requires re-running the
adjacency script described in "Measurement method" against current `main`
and computing the minimal edge cut per slice — that is a data-generation
task, not something reliable to keep re-deriving by hand, one edge at a
time, in doc review. Treat the ordered-slice-plan's exact prerequisites as
directionally correct (something beyond the two-node cycles blocks each of
2-4) but not yet fully specified.

Measurement method: for every top-level module under `packages/tui-rs/src`
(each subdirectory or standalone `.rs` file other than `lib.rs`/`main.rs`),
every `crate::<mod>` / `use crate::<mod>` reference was extracted and
resolved to its target top-level module. A module set `S` is extractable as
a leaf crate iff no member of `S` references a `tui-rs` module outside `S`
(other modules referencing into `S` is fine — a facade re-export from
`tui-rs`'s lib root solves that direction). Hot files in this snapshot are
the file-level union of changed-file lists for the 48 PRs open at the cutoff.
For a live snapshot, the equivalent command is
(`gh pr list --state open --limit 100 --json number,files`). The explicit
limit is required because `gh pr list` otherwise returns only 30 entries.
The recorded snapshot is
2026-07-25T19:24:39Z, when #3141 brought the open set to 48 PRs.
The recorded counts first appeared in commit
`5955bf5921df7d81867d4f37996cd3f0097c613c`.

The exact open-set input was #3090, #3092, #3093, #3094, #3096, #3097,
#3098, #3099, #3100, #3101, #3102, #3103, #3104, #3105, #3106, #3107,
#3108, #3110, #3111, #3112, #3113, #3114, #3115, #3116, #3117, #3118,
#3119, #3120, #3121, #3122, #3124, #3125, #3126, #3127, #3128, #3129,
#3130, #3131, #3132, #3133, #3134, #3135, #3136, #3137, #3138, #3139,
#3140, and #3141. Reconstruct that historical set by selecting PRs where
`createdAt <= 2026-07-25T19:24:39Z` and either `closedAt` is null or
`closedAt > 2026-07-25T19:24:39Z`. This reconstructs PR membership only.
The command above exposes each PR's current changed-file list. Forty-seven
of the 48 PRs advanced after the cutoff, so the historical file-list union
cannot be reconstructed from current API results. The counts below are the
recorded 2026-07-25 results.

## Measured graph: summary table

File count, LOC, hot-file overlap, and outgoing edges for the modules
relevant to the target architecture below (`agent`/`components`/`app`
included for context on the cycle):

| Module | Files | LOC | Hot files (open PRs) | Outgoing edges to other top-level modules |
|---|---:|---:|---:|---|
| `ai` | 13 | 10,231 | 0 / 13 | *(none)* |
| `execpolicy` | 1 | 1,870 | 1 / 1 (`#3126`) | *(none)* |
| `sandbox` | 1 | 1,931 | 0 / 1 | *(none)* |
| `swarm` | 5 | 3,604 | 0 / 5 | *(none)* |
| `hooks` | 10 | 5,452 | 1 / 10 (`#3133` touches `hooks/config.rs`) | *(none)* |
| `skills` | 3 | 4,872 | 1 / 3 | `path_utils`, `plugins`, `skill_package_cli` |
| `safety` | 9 | 6,825 | 3 / 9 (`#3121`, `#3126`, `#3128`… guardian/analyzer) | `agent`, `lsp`, `mcp`, `path_utils`, `tools` |
| `session` | 9 | 8,168 | 2 / 9 (`#3129`) | `agent` |
| `agent` | 11 | 9,584 | 3 / 11 (`#3141` swallowed-Result PR) | `ai`, `hooks`, `mcp`, `safety`, `state`, `tools` |
| `tools` | 29 | 28,914 | 13 / 29 (`#3118`, `#3133`, `#3136`, `#3141`…) | `agent`, `ai`, `config`, `lsp`, `mcp`, `plan_mode`, `safety`, `sandbox` |
| `headless` | 14 | 16,301 | 1 / 14 (`#3141`) | `agent`, `ai` |
| `components` | 25 | 14,549 | 5 / 25 (`#3128`, `#3129`, `#3136`, `#3138`) | 19 modules incl. `agent`, `session`, `state`, `tools` |
| `app` | 9 | 10,675 | 5 / 9 (`app.rs`; `command_handlers.rs`, `input_handlers.rs`, `session_recording.rs`, `tests.rs`) | 38 modules incl. `agent`, `ai`, `session`, `tools` |

`ai` is the largest module in this table with **zero** outgoing edges and
**zero** hot-file overlap. It has seven reverse dependents (`agent`, `app`,
`doctor`, `headless`, `mcp`, `model_catalog`, `tools`). It also has an
existing external consumer outside `tui-rs`: `packages/control-plane-rs/src/lib.rs`
does `use maestro_tui::ai::Tool;` today, so the type already has a
crate-external public API shape.

Selected adjacency for the modules used in the seam decision below. This is
not the complete non-leaf graph: modules such as `checkpoints`, `doctor`, and
`lsp` also have outgoing edges but are omitted because they were not
load-bearing for the original first-slice decision.

```
a2a_cli        -> operating_plane_client, path_utils, skill_cli
agent          -> ai, hooks, mcp, safety, state, tools
app            -> agent, ai, checkpoints, clipboard, commands, components,
                   config, config_cli, config_watcher, exec_commands,
                   file_mentions, files, git, headless, history, key_hints,
                   keybindings, magic_trace, mcp, model_catalog,
                   model_monitor, notifications, palette_resource,
                   path_utils, plan_mode, plugins, prompts, safety, session,
                   skills, state, terminal, terminal_info, themes, tools,
                   ui_state, usage, wrapping
commands       -> exec_commands, git, keybindings, lsp, prompts, skills,
                   state, tool_output
components     -> agent, checkpoints, commands, effects, files, keybindings,
                   model_catalog, palette, palette_resource, protocol,
                   runtime_badges, session, state, terminal, themes,
                   tool_output, tool_summary, tools, wrapping
headless       -> agent, ai
mcp            -> ai, path_utils
model_catalog  -> ai, path_utils
safety         -> agent, lsp, mcp, path_utils, tools
session        -> agent
state          -> agent, components, kill_ring, session
tools          -> agent, ai, config, lsp, mcp, plan_mode, safety, sandbox
```

(The one-off script generated complete per-module adjacency and
reverse-dependency counts, but this document retains only the selected block
above. Re-run the measurement method before using it to plan a later slice.)

### Cycle analysis

Tarjan SCC over the full adjacency finds exactly one non-trivial strongly
connected component, 19 modules wide:

```
agent, commands, components, exec_commands, mcp, model_catalog,
palette_resource, path_utils, plan_mode, plugins, prompts, runtime_badges,
safety, session, skill_cli, skill_package_cli, skills, state, tools
```

`agent <-> tools` is a two-node cycle inside this SCC: `agent` calls into
`tools` to execute tool calls, and `tools` calls back into `agent` (approval
flow / tool-call construction types). `safety <-> tools` is a second
two-node cycle for the same reason (execution asks safety for a policy
verdict; safety's guardian path references tool execution types). This is
exactly the coupling the target hypothesis below calls out as needing a
`PermissionRequestHandler`-style inversion (issue `#2656`) before `tools`,
`safety`, or `session` can be pulled out as leaf crates — none of them are
cycle-free today, and unlike `ai`, they are also all *currently* hot.

`ai` is not a member of this SCC and cannot be, structurally: it has zero
outgoing edges, so nothing it depends on can depend back on it.

## Target end-state: hypothesis vs. measurement

The owner's hypothesis (restated) and what the data says:

- **`maestro-ai`** (provider layer: `ai/client.rs` trait, provider impls,
  model catalog) — **confirmed cold and cycle-free.** `ai/` itself has zero
  outgoing `crate::` edges. `model_catalog.rs` (top-level file, not part of
  `ai/`) does depend on `ai` and on `path_utils`, but nothing in `ai/`
  depends on `model_catalog`, so `model_catalog.rs` is left in `tui-rs` for
  now (own reverse-dependency count of 6; a candidate for a later,
  separately-scoped slice, not bundled into this one to keep the first PR
  minimal). No contradiction found — proceed with `maestro-ai` = `ai/` only.
- **`maestro-policy`** (`safety/`; `maestro-execpolicy` is already extracted) — **hot now, and cyclic.**
  The former `execpolicy.rs` module had zero outgoing edges and zero *other*
  hot overlap besides itself, so it was extracted without taking `safety/`
  along. The dependency-free leaf now ships as `maestro-execpolicy`. `safety/`
  has
  3 of 9 files hot and sits inside the 19-module SCC via `tools`/`agent`.
  Map only, as directed; do not touch. **Correction:** `safety/` also has
  direct outgoing edges to `lsp` (`safety/safe_mode.rs`), `mcp`
  (`safety/firewall.rs`), and `path_utils` (`safety/policy.rs`), all
  confirmed by reading the files. Ordering step 3 after `maestro-exec`
  (step 2) resolves the edge into `tools` but not these three — if `lsp`/
  `mcp`/`path_utils` remain in `tui-rs`, extracting `safety` alone would
  create the same `maestro-policy -> tui-rs -> maestro-policy` package-cycle
  problem described under `maestro-exec` above. Gating step 3 only on "the
  tools edge becomes `maestro-exec`" is insufficient; the plan needs to
  account for all of `safety`'s remaining outbound edges, not just the one
  into `tools`.
- **`maestro-session`** (`session/`, checkpoints) — **hot now, and in the
  cycle** via `session -> agent -> tools -> ... -> session`. 2 of 9
  `session/` files are directly hot (`#3129`, session index/fork/switcher
  work). Map only, as directed; do not touch.
- **`maestro-exec`** (`tools/`, `sandbox`, `bash`) — **the most hot module
  in the workspace right now** (13 of 29 `tools/` files touched by open
  PRs, plus `agent/native.rs` which `tools` calls back into) **and** the
  anchor of both two-node cycles (`agent<->tools`, `safety<->tools`).
  `sandbox.rs` itself is cold and cycle-free in isolation, but it is not a
  useful seam on its own —
  `packages/tui-rs/src/tools/bash/mod.rs` directly invokes
  `spawn_sandboxed_command`, so sandboxing remains part of the broader,
  hot tool-execution seam. Confirms the
  brief's note: extracting this seam requires inverting the approval
  callback via a `PermissionRequestHandler` trait (or moving the shared
  request/response types into a lower layer) before `tools` can stop
  depending on `agent`. Tracked by `#2656` (open: "Refactor approval: thin
  PermissionRequestHandler + strategy injection per mode"). Map only.
  **Correction (revised after a second round of review):** an earlier
  version of this correction claimed `config`/`lsp`/`mcp`/`plan_mode` were
  "cold, zero-outgoing-edge leaves" that could be safely co-extracted or
  facaded alongside `tools`. That collective claim was checked and is
  **wrong for `lsp`, `mcp`, and `plan_mode`**, although `config` itself is a
  zero-outgoing leaf —
  `plan_mode.rs` imports `crate::safety` directly; `mcp/config.rs` imports
  `crate::path_utils`, which itself imports `crate::safety`; `lsp.rs`
  imports `crate::files`; and `safety/safe_mode.rs`, `safety/firewall.rs`,
  and `safety/policy.rs` import `lsp`, `mcp`, and `path_utils` respectively
  (all confirmed by reading the files). `plan_mode` and `path_utils` are
  already listed as members of the 19-module SCC above, and `mcp` reaches
  back into that SCC through `path_utils` and `safety`. `lsp` does not:
  it points to `files`, which has no outgoing top-level-module edge, so it
  remains a one-way outbound dependency of the SCC. The
  correct, load-bearing conclusion is
  simpler and more conservative than either version of this bullet
  attempted: **`tools` is a member of the 19-module strongly connected
  component**, which means it is mutually reachable with all 18 other
  members (`agent`, `commands`, `components`, `exec_commands`, `mcp`,
  `model_catalog`, `palette_resource`, `path_utils`, `plan_mode`, `plugins`,
  `prompts`, `runtime_badges`, `safety`, `session`, `skill_cli`,
  `skill_package_cli`, `skills`, `state`) — not just `agent` and `safety`.
  Extracting `tools` alone into `maestro-exec` cannot produce a clean leaf
  crate by breaking two named two-node cycles; it requires enough of the
  SCC's internal edges broken (via `PermissionRequestHandler` and further
  inversions not yet designed) that the resulting `maestro-exec` boundary
  has zero outgoing edges into whatever remains in `tui-rs`. Getting the
  *exact* minimal edge set to break requires re-running the adjacency
  script mentioned in the measurement method above against current `main`
  and computing it precisely — that is a data-generation task, not
  something to keep hand-verifying one edge at a time in doc review. This
  document's precise step-2 prerequisites should be treated as **not yet
  fully specified** until that re-run happens; `#2656` is necessary but the
  measurement here does not show it is sufficient.
- **`maestro-tui` slims to UI** (`components/`, `app`, `themes`, input) —
  **not reachable as the next slice.** `components/` has outgoing edges
  into 19 other modules including `agent`, `session`, `state`, and `tools`
  — i.e., it is a member of the same 19-module SCC, not a clean UI leaf.
  `app.rs` is worse: 38 outgoing edges, effectively touching every
  subsystem. At the recorded 48-PR snapshot, 4 of 8 `app/*.rs` sub-files were
  hot (`command_handlers.rs`, `input_handlers.rs`, `session_recording.rs`,
  `tests.rs`), as was the `app.rs` module root: 5 of 9 files total. Slimming `tui-rs`
  to pure UI is the *last* slice, gated on the `agent<->tools`/
  `safety<->tools` cycle break, not something to attempt now.
  **Correction:** the `app` module's file/LOC count above originally omitted
  its own module root, `packages/tui-rs/src/app.rs` (2,674 LOC at
  measurement time, currently 2,857 LOC as the file keeps growing) — the
  module is that root plus the 8 files under `packages/tui-rs/src/app/`,
  i.e. 9 files and
  ~10,675 LOC, not 8 files/8,001 LOC. `app.rs` itself is also independently
  hot in that same recorded snapshot. This does not change the conclusion
  (`app` is still not a clean UI leaf), but the size and hot-overlap numbers
  above now use one consistent snapshot and include the module root.

No contradiction of the owner's hypothesis was found for the seam that
matters this round: `ai/` is cold, cycle-free, has no hot-file overlap, and
is the largest such candidate (10,231 LOC vs. the next largest cold/cheap
leaf, `hooks/` at 5,452 LOC, which has one hot file). The `themes`
size in the "UI slice" hypothesis (only ~990 LOC across 2 files) confirms
the eventual UI-only crate is real but blocked on `components`/`app`
untangling from the SCC, not on anything specific to `ai`.

## Ordered slice plan

1. **`maestro-ai`** — cold, cycle-free, zero hot overlap, largest available
   leaf. **Shipped** as
   [#3148](https://github.com/evalops/maestro-internal/pull/3148).
2. **`maestro-exec`** (`tools/`, `sandbox`, `bash`) once the in-flight hot
   PRs against `tools/*` and `agent/native.rs` land and the
   `PermissionRequestHandler` inversion (`#2656`) is merged. Unblocks
   `#2658`/`#2609` (daemon split — the daemon needs a tool-execution layer
   that doesn't drag in the TUI's `agent`/`state` types) and `#2645`
   (multi-agent orchestration primitives, which need tool execution
   decoupled from the single-agent `agent` module).
3. **`maestro-policy`** (`safety/`) once `#3121`/`#3126`/`#3128` land and
   `maestro-exec` exists. The dependency-free `maestro-execpolicy` leaf is
   already extracted; the remaining safety edge into `tools` needs
   `maestro-exec` first, or the same inversion applied a second time).
   Unblocks `#2647` (client SDKs need a stable, crate-boundary policy
   surface to describe, not an internal module).
4. **`maestro-session`** (`session/`, `checkpoints`) once `#3129` lands and
   `session`'s dependency on `agent` (**correction:** the measured edge runs
   `session -> agent`, not the reverse; the adjacency table above already
   states this correctly, but this bullet had the direction backwards) is
   resolved. `checkpoints.rs` also has its own outgoing edge to `git`, so
   the `session/`, `checkpoints` bundle is not itself edge-free either —
   `git` is cold/leaf so this doesn't add a new cycle, but it is a second
   dependency this slice needs to account for beyond the `agent` edge.
   The complete proposed session slice is 8,976 LOC (`session/` at 8,168
   plus `checkpoints.rs` at 808), which is larger than the historical 7,736-LOC
   policy estimate. That estimate included `safety/` at 6,825 plus the former
   `execpolicy.rs` at 911; the current execution-policy crate is 1,870 LOC.
   It remains fourth
   because of the dependency sequence and unresolved `agent`/`git` edges,
   not because it is the smallest deferred seam; it does not strictly block
   anything upstream by itself.
5. **`maestro-tui` slims to UI** (`components/`, `app/`, `themes/`, input)
   after 2-4 land and `components`/`app` no longer need `agent`/`session`/
   `state`/`tools` as sibling modules in the same crate — they'll depend on
   the new leaf crates instead. This is the step that actually shrinks
   `tui-rs`'s share of the workspace; issue `#2628` ("shared protocol
   package") is **closed** already (superseded/resolved) and is not a
   dependency of this slice; no other open roadmap issue is currently
   blocked specifically by the UI slice. **Gap found:** steps 2-4 extract
   `tools`, `safety`, and `session`, but none of them touch
   `agent` or `state`, which have their own two-node cycle
   (`agent/native.rs` imports `state`; `state.rs` imports `agent`) that
   `components` (`components/operations.rs`, `components/message.rs`) and
   `app` both depend on directly. Steps 2-4 alone do not make `agent`/`state`
   cease being sibling modules of `components`/`app` inside `tui-rs` — this
   slice needs an explicit `agent<->state` cycle break (or an `agent`/`state`
   extraction of its own) added to the plan before "UI-only" is accurate,
   not just steps 2-4 landing.

## First extraction: `maestro-ai` (shipped as #3148)

This section was written as the extraction plan before the PR landed; it is
kept as the record of what was planned and is annotated below with what
actually shipped. The plan matched the measurement, with one addition the
original bullets did not anticipate (the `test_support` cross-crate
feature-flag plumbing, noted inline below).

- New workspace member `packages/ai-rs`, crate name `maestro-ai`, package
  name pattern matching `packages/control-plane-rs` / `maestro-control-plane`.
  **Landed as planned** (`Cargo.toml` workspace `members` and
  `[workspace.dependencies]` both carry `packages/ai-rs` / `maestro-ai`).
- `packages/ai-rs/src/` contains the history-preserving move of the former
  in-tree `ai` module,
  `ai/mod.rs` becomes `ai-rs/src/lib.rs`. **Landed as planned.**
- Facade in `tui-rs`'s `lib.rs`: `pub mod ai;` (line 61) becomes
  `pub use maestro_ai as ai;`. Note this had to stay **`pub`**, not
  `pub(crate)` as the brief's illustrative snippet suggested — measurement
  showed `packages/control-plane-rs/src/lib.rs` does
  `use maestro_tui::ai::Tool;` today, so the re-export has to remain
  externally visible or that crate breaks. `pub use` keeps
  `maestro_tui::ai::Tool` resolving unchanged; `control-plane-rs` was not
  touched. **Landed as planned**: `packages/tui-rs/src/lib.rs` now reads
  `pub use maestro_ai as ai;` and `packages/control-plane-rs/src/lib.rs`
  still does `use maestro_tui::ai::Tool;` unmodified.
- Zero outgoing edges from `ai/` means zero call-site rewrites are needed
  anywhere else in `tui-rs`: every existing `crate::ai::...`/`ai::...` path
  keeps resolving through the facade. **Landed as planned for source paths,
  with one addition this bullet did not anticipate:** `doctor.rs`'s
  auth-health tests call `crate::ai::op_secret::test_support::FakeOp`, a
  `#[cfg(test)]`-only helper. Dependency crates are not built with the
  *consuming* crate's `cfg(test)`, so a plain `pub use` facade cannot expose
  it across the new crate boundary by source path alone. The landed fix
  (`packages/ai-rs/src/op_secret.rs`) gates `test_support` behind
  `#[cfg(any(test, feature = "test-support"))]` and `packages/tui-rs/Cargo.toml`
  adds `maestro-ai = { workspace = true, features = ["test-support"] }` as a
  dev-dependency override. This Cargo-level feature-flag plumbing was a real
  extra step beyond "the facade preserves every path," not a rewrite of
  `doctor.rs` itself.
- `Cargo.toml`/`packages/tui-rs/Cargo.toml`/`packages/tui-rs/src/lib.rs` are
  all in the current hot-file union (touched by `#3140`, `#3127`, `#3128`,
  `#3093`, `#3092`, `#3090` on `Cargo.toml` files; `#3127`, `#3094` on
  `lib.rs`). These are judgment-call exceptions to the "don't touch hot
  files" rule: every one of those PRs makes a single-line, alphabetically-
  scoped append (a new `[workspace.dependencies]` entry, a new `pub mod`
  line) to a shared manifest/dispatch file that *every* dependency-adding
  or module-adding PR in this repo necessarily touches. This is mechanical
  textual overlap (worst case: a trivial alphabetical-ordering merge
  conflict), not the semantic hot-file collision the rule exists to avoid
  (two PRs changing the same function's behavior). The actual edit points
  were checked against each hot PR's diff: our `lib.rs` edit is at line 61
  (`pub mod ai;`); the two hot `lib.rs` PRs edit near line 78
  (`crash_handler`) and line 204 (`process_hardening`) — no line-range
  overlap. Our `Cargo.toml` edit is a new alphabetically-placed
  `maestro-ai = { path = "packages/ai-rs" }` entry next to the existing
  `maestro-control-plane`/`maestro-tui` lines, in the same region three
  other open PRs also append to — flagged here as the one accepted,
  low-severity conflict-surface exception in this PR.
