# Plan: Subagent operations parity

> **For the implementation agent:** Execute this plan inline in the current feature branch, using test-driven development for each behavior.

**Goal:** Bring the native Maestro subagent runtime up to the concrete intersection of Kimi Code and Grok: role-safe delegation, durable background execution, bounded scheduling, reusable profiles, explicit worktree cleanup, model-invocable skills, and plugin-provided agents/hooks.

**Base:** `origin/main` (`a9871a015`)

**Verification:** `cargo test -p maestro-tui` plus focused test filters while iterating; `cargo fmt --check`; `cargo clippy -p maestro-tui --all-targets -- -D warnings` where the repository baseline permits it.

## Task 1: Role policies and profiles

- Add failing unit tests for Explore/Plan/Code/Review tool allowlists and profile resolution.
- Add an explicit role policy layer to native child tool construction. Explore is read-only, Plan is read-only plus plan tools, Review is read-only plus review evidence, and Code retains mutation tools.
- Add profile selection to `spawn_subagent`, load project/user profiles through the existing profile format, and make profile tools a narrowing allowlist rather than a privilege escalation.
- Include the resolved profile and policy in durable records and child prompts.

## Task 2: Budgets, scheduling, and lifecycle notifications

- Add failing tests for bounded concurrency, child execution timeout, max output-token configuration, and terminal lifecycle events.
- Add configurable per-child timeout/max-token budgets and a process-wide semaphore so background children queue instead of overcommitting the runtime.
- Persist explicit terminal states, including timed out/interrupted children, and reconcile stale queued/running records on restart.
- Emit parent-visible completion/failure events when background children finish, including the child id, status, and summary.

## Task 3: Worktree lifecycle controls

- Add failing tests for inspecting and cleaning a completed child worktree.
- Add durable `inspect_subagent` and `cleanup_subagent` operations. Cleanup is only allowed for terminal children and removes the worktree safely while retaining the durable record.
- Preserve dirty worktrees until the caller explicitly cleans them up; expose the reason when cleanup cannot proceed.

## Task 4: Skill invocation semantics

- Add failing tests for automatic skill matching and `disable-model-invocation`.
- Add an automatic activation path for user prompts based on skill trigger metadata, honoring disabled model invocation and user-invocable restrictions.
- Include the selected skill instructions in the active agent prompt and keep nested skill activation bounded.

## Task 5: Plugin agents and hook backends

- Add failing manifest/loader tests for plugin-provided agents.
- Extend plugin manifests and capability discovery with agent definitions and load them into the profile/agent registry.
- Execute supported plugin command and HTTP hooks through the existing hook dispatcher with bounded timeouts and clear failure reporting, while preserving existing Rust/Lua/WASM behavior.

## Task 6: Verification and integration

- Run focused tests after each task and the full relevant Rust checks on the final tree.
- Review the diff for unrelated changes and update user-facing documentation/changelog entries for the new subagent operations.
- Commit, push, open the PR against `main`, wait for required checks, merge it, and verify the remote `main` contains the merge.
