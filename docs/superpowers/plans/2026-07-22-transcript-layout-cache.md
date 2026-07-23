# Transcript Layout Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache exact transcript message heights and use cumulative offsets so busy-frame rendering reparses only changed messages and jumps directly to the visible window.

**Architecture:** A private `MessageLayoutCache` in `AppState` reconciles cheap per-message height keys against cached exact heights. It stores cumulative bottom offsets for binary-search viewport selection, while `ChatView` remains responsible for exact measurement and visible widget rendering.

**Tech Stack:** Rust 2021, Ratatui, Criterion 0.5, Cargo.

## Global Constraints

- Preserve exact message rendering and bottom-anchored scroll semantics.
- Do not add dependencies or estimated-height behavior.
- Use `usize` for transcript totals and clamp only at Ratatui's `u16` coordinate boundary.
- Follow red-green-refactor for every production behavior.

---

### Task 1: Exact-height cache and viewport lookup

**Files:**
- Create: `packages/tui-rs/src/components/message_layout.rs`
- Modify: `packages/tui-rs/src/components/mod.rs`

**Interfaces:**
- Consumes: ordered `MessageLayoutKey` values and an exact-height closure.
- Produces: `MessageLayoutCache::prepare(width, settings_key, keys, measure) -> MessageLayout`; `MessageLayout::{heights, total_height, first_visible(window_top)}`.

- [ ] **Step 1: Write failing cache tests**

Add unit tests that count measurement calls and assert: the first prepare measures all entries; the identical second prepare measures none; changing one key measures one entry; appending measures only the suffix; width/settings changes trigger the documented invalidation; and cumulative bottoms select the first entry whose bottom exceeds `window_top`.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p maestro-tui components::message_layout::tests --lib`

Expected: compilation fails because `message_layout` and its cache types do not exist.

- [ ] **Step 3: Implement the minimal cache**

Define `MessageLayoutKey`, `MessageLayoutCache`, internal cached entries, and an owned `MessageLayout`. Reconcile ordered entries, reuse matching heights, rebuild cumulative `usize` bottoms, and implement `first_visible` with `slice::partition_point(|bottom| *bottom <= window_top)`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cargo test -p maestro-tui components::message_layout::tests --lib`

Expected: all message-layout tests pass with zero failures.

- [ ] **Step 5: Commit**

Run: `git add packages/tui-rs/src/components/message_layout.rs packages/tui-rs/src/components/mod.rs && git commit -m 'perf(tui): cache transcript layout heights'`

### Task 2: Integrate cache into ChatView

**Files:**
- Modify: `packages/tui-rs/src/state.rs`
- Modify: `packages/tui-rs/src/components/message.rs`

**Interfaces:**
- Consumes: `MessageLayoutCache` and `MessageLayoutKey` from Task 1.
- Produces: `AppState::message_layout_cache()` and a cached `ChatView::render_messages` path with unchanged output.

- [ ] **Step 1: Write failing integration tests**

Add tests beside `ChatView` that render a multi-message state twice and assert the layout cache records no additional exact measurements on the second render; append content to the final message and assert only one additional measurement; render at another width and assert all renderable messages are remeasured; verify an over-65,535-row synthetic layout does not overflow and selects the correct visible suffix.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p maestro-tui components::message::tests --lib transcript_layout`

Expected: compilation fails because `AppState` does not own a layout cache and `ChatView` still calculates every height directly.

- [ ] **Step 3: Implement AppState ownership and ChatView integration**

Add a private `RefCell<MessageLayoutCache>` initialized by `AppState::new`. Build `MessageLayoutKey` values from height-affecting message/tool fields, prepare the cache with `calculate_message_height`, compute the bottom-anchored window with `usize`, use `first_visible`, and render the same visible `MessageWidget` sequence. Keep the cache borrow out of the widget-render loop.

- [ ] **Step 4: Run focused and package tests**

Run: `cargo test -p maestro-tui components::message::tests --lib transcript_layout && cargo test -p maestro-tui`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit**

Run: `git add packages/tui-rs/src/state.rs packages/tui-rs/src/components/message.rs && git commit -m 'perf(tui): reuse transcript layout across frames'`

### Task 3: Long-transcript benchmark

**Files:**
- Create: `packages/tui-rs/benches/message_layout_bench.rs`
- Modify: `packages/tui-rs/Cargo.toml`
- Modify: `packages/tui-rs/src/components/mod.rs`

**Interfaces:**
- Consumes: a narrow benchmark-facing layout preparation helper using the production cache.
- Produces: Criterion groups `message_layout/cold`, `message_layout/steady`, and `message_layout/streaming_tail` for 1,000 messages.

- [ ] **Step 1: Add benchmark target and fixture**

Create 1,000 representative Markdown messages and benchmark cold cache population, unchanged steady-state preparation, and a tail key change per iteration. Register `message_layout_bench` with `harness = false`.

- [ ] **Step 2: Compile and smoke-run the benchmark**

Run: `cargo bench -p maestro-tui --bench message_layout_bench --no-run && cargo bench -p maestro-tui --bench message_layout_bench -- --sample-size 10 --measurement-time 1`

Expected: benchmark compilation and all three groups complete successfully.

- [ ] **Step 3: Record before/after evidence**

Temporarily benchmark the old direct-measurement loop in the same fixture, record its median beside the cached medians in the commit message/PR body, then remove the temporary baseline code so only maintainable production benchmarks remain.

- [ ] **Step 4: Commit**

Run: `git add packages/tui-rs/Cargo.toml packages/tui-rs/src/components/mod.rs packages/tui-rs/benches/message_layout_bench.rs && git commit -m 'bench(tui): cover cached transcript layout'`

### Task 4: Full verification, publication, merge, and install

**Files:**
- Modify only files required by failures causally introduced by Tasks 1–3.

**Interfaces:**
- Consumes: completed cache, integration, and benchmark commits.
- Produces: verified PR, merged main commit, and matching `/home/developer/.local/bin/maestro` binary.

- [ ] **Step 1: Run fresh verification**

Run: `cargo fmt --all -- --check && cargo clippy -p maestro-tui --all-targets -- -D warnings && cargo test -p maestro-tui && cargo build --release --locked -p maestro-tui --bin maestro-tui`

Expected: every command exits zero; the package test summary reports zero failures.

- [ ] **Step 2: Publish without rewriting history**

Run: `git status --short`, inspect `git diff origin/main...HEAD`, then `git push -u origin agent/file-search-performance`. Update the existing PR with benchmark and verification evidence and leave auto-merge enabled.

- [ ] **Step 3: Verify required GitHub checks and merge**

Use `gh pr checks` and `gh pr view` until all required checks pass. Merge normally; do not use admin bypass, disable checks, or force-push. Pull main and verify the merge commit contains all task commits.

- [ ] **Step 4: Build and install main atomically**

Build main into a clean target directory, stage the binary under `/home/developer/.local/bin`, atomically rename it to `maestro`, and verify `command -v maestro`, `maestro --help`, source/installed SHA-256 equality, executable mode, and main revision provenance.

- [ ] **Step 5: Report evidence**

Report benchmark medians, exact test/lint/build commands and outcomes, PR/merge commit, installed path/checksum, and any external CI blocker without claiming completion if required checks remain blocked.
