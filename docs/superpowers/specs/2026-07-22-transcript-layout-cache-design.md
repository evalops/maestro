# Transcript Layout Cache Design

## Context

Maestro redraws continuously while an agent is busy. `ChatView::render_messages` currently collects every renderable message, reparses and wraps Markdown for every message, sums every height, and linearly scans from the beginning before it renders the visible slice. A long transcript therefore makes every streaming frame proportional to the full transcript's parsing cost, even though only the active message normally changes.

The current `xai-org/grok-build` pager avoids this cost by caching parsed/layout state, updating dirty entries only, storing cumulative virtual positions, and locating the visible window with `partition_point`. Maestro should adopt the smallest exact-height subset of that design.

## Goals

- Preserve byte-for-byte-visible message behavior, bottom-anchored scrolling, scrollbar behavior, thinking expansion, and compact/expanded tool output behavior.
- Reuse exact message heights across frames when the viewport width and height-affecting message inputs have not changed.
- Recalculate only changed messages during streaming.
- Locate the first visible message with a prefix-offset binary search.
- Add regression tests and a reproducible Criterion benchmark for long transcripts.

## Non-goals

- Cache fully rendered Ratatui buffers or styled Markdown trees.
- Use estimated offscreen heights or viewport settling.
- Change transcript persistence, message ordering, or input handling.
- Add a dependency.

## Design

Add a focused `components/message_layout.rs` module. `MessageLayoutCache` owns the last layout width, compact-output mode, expanded-tool signature, ordered entries, cumulative bottom offsets, and total height. Each entry contains the message ID, a cheap height-affecting key, and the exact cached height.

The key includes content and thinking lengths, streaming and thinking-expanded flags, message kind/role, tool-call count, and the height-affecting fields of every tool call. Production mutations append content/output or toggle explicit flags, so these keys detect the relevant changes without hashing full transcript strings. The global expanded-tool set is represented by a deterministic order-independent signature; changing it or compact-output mode invalidates tool-sensitive measurements. Viewport width changes invalidate all heights.

On `prepare`, the cache walks renderable messages in order and reuses an entry only when its ID and key match at that position. It calls the supplied exact-height function for new or changed entries, truncates removed entries, rebuilds cumulative bottoms only from the first changed position, and returns a `MessageLayout` view. The walk remains O(number of messages) but consists of cheap scalar comparisons instead of Markdown parsing and wrapping. The cumulative offsets allow `partition_point` to locate the first visible message in O(log n).

`AppState` owns the cache in a private `RefCell`, allowing Ratatui's immutable `Widget::render` interface to reuse layout state without global state or unsafe code. `ChatView::render_messages` borrows it only while preparing/copying the compact layout result, releases the borrow, and then renders visible messages normally.

All totals and offsets use `usize`; conversion to terminal `u16` happens only after clamping to the viewport. This also eliminates the existing debug-overflow risk when transcripts exceed 65,535 rows.

## Correctness and invalidation

- Width change: all exact heights are recomputed.
- Content/thinking/tool-output append: only the affected message key changes.
- Thinking toggle: only that message key changes.
- Tool expansion or compact-output change: tool-bearing entries are remeasured; ordinary messages remain reusable.
- Append: prior entries remain reusable and only the suffix is measured.
- Removal, compaction, reorder, or replacement: the first positional ID/key mismatch invalidates that suffix.
- Non-renderable messages remain absent from cache and preserve the welcome-state behavior.

## Verification

Unit tests use an instrumented measurement closure to prove cache hits, single-entry invalidation, suffix repair, width invalidation, settings invalidation, and binary-search viewport selection. Existing message-render tests protect visual semantics. A Criterion benchmark prepares and repeatedly updates a 1,000-message transcript, reporting cold layout and steady-state/streaming layout separately.

Run the package test suite, formatting check, Clippy with warnings denied, benchmark smoke run, and release build before publishing. GitHub CI remains authoritative for merge; required checks will not be bypassed.
