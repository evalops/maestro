# Maestro interaction library

Reusable interaction behavior for native applications. The crate has no external
runtime dependencies and does not import Dex, `ratatui`, application state,
persistence, tools, or an executor.

Use it when a view needs attention tracking, a bounded reaction, a selectable
list, or a draft suggestion. Continue to use your application's authoritative
turn/tool/approval events. A display state is never authorization to run work.

## Define an option once

```rust
use maestro_interaction::{Action, Selection};

#[derive(Clone, Copy)]
enum Appearance { Mint, Rose }

let options = [
    Action::new("accent-mint", "Mint", Appearance::Mint),
    Action::new("accent-rose", "Rose", Appearance::Rose),
];
let mut selection = Selection::default();
selection.down(options.len());
let intent = selection.get(&options).map(|option| option.value);
// The host handles `intent`, persists through its existing preference owner,
// and reports success only after that save succeeds.
```

IDs are stable identifiers for commands and fixtures; labels are presentation.
Reordering a catalog does not change its values. Match command input against
`Action::id`, render `Action::label`, and handle `Action::value` exhaustively.
Selection returns `None` for an empty list. Call `reconcile` after filtering.

## Observe events, handle effects, then render

`Attention<S>` works with any `Copy + Eq` state `enum`. Feed it `Started`,
`Observed`, `FocusLost`, `FocusGained`, and `Reset` events. The host supplies
both monotonic `Duration` timestamps and current `Policy` preferences.

- `Started` distinguishes consecutive interactions that need the same attention.
- Duplicate observed states do not request duplicate notifications.
- `FocusGained` observes the latest state before consuming the absence, so a
  completion immediately before focus return needs no intervening render.
- Focus return can request a recap but never a desktop notification.
- `Reset` forgets the previous session's transient state.
- `Policy::notifications` defaults off. Supply the current platform/focus policy
  too; a returned effect is a request, not proof it was delivered.

The host maps its own events to an observed state and an `attention` flag.
No prose, tool-name guessing, timer, or animation decides whether work succeeded.
Handle `Effects::notification` and `Effects::recap` outside the renderer. Recap
text must come from the host's recorded execution evidence.

## Render with maestro-ui

`maestro-ui::ActionList` renders the same typed catalog with the caller's
`ListState` and `UiTheme`. `Notice` displays a caller-owned hint/status line in
explicit bounds. Compose these with existing `Modal`, `Picker`, `SearchField`,
and `SettingsForm`; no additional event loop or global theme is installed.

Dex consumes these primitives in `maestro-tui/src/app/dex_presentation.rs`.
The theme selector is a second consumer of `Selection`, paired with the existing
shared `Picker`. Dex artwork, activity wording, tool classification, and factual
recap construction stay in the product crate.

## Reactions and suggestions

`Reaction` returns a bounded frame from the supplied clock, interval, and
lifetime. Respect reduced-motion settings in the host. It never changes the
observed state, hides approval controls, or starts a perpetual animation.

`Suggestion` handles dismissal and one-shot acceptance of any typed value.
Before offering one, the host checks that its editor is empty, no modal owns
input, and suggestions are enabled. `take` returns a value only; filling the
editor and submitting it are separate host actions. Reset at the next turn.

## Test without sleeps or real effects

From `products/maestro`:

```sh
cargo test -p maestro-interaction --locked
cargo run -p maestro-interaction --example task_monitor --locked
cargo test -p maestro-ui --locked
```

The example replays timestamped events, prints requested effects, and accepts a
draft without running it. Tests use explicit timestamps as a fake clock and
assert values returned by the actual reducer. Add a replay for each lifecycle
edge case, then keep host integration tests for editor/modal eligibility and
persistence failures. Use the native screenshot harness for actual rendering.

To add a Dex appearance option, add its typed `enum` variant/artwork and one
`Action<Appearance>` entry. No numeric switch or main-loop edit is needed. To
add another consumer, define its state `enum`, translate its lifecycle events,
handle effects in its existing owner, and pass read-only data to widgets.

## Complete native pickers

Use `maestro_ui::ActionPicker<T>` when a modal needs navigation, optional search,
scrolling, confirmation, and cancellation. The application owns the picker and
routes input to it only while that modal is active. `open()` resets its query
and selection. `handle_key()` returns `Pending`, `Changed(Option<T>)`, `Selected(T)`, or `Cancelled`;
confirmation and cancellation close it, so the result is returned once.
An empty confirmation returns `Cancelled`. The application still saves
preferences, changes themes, or executes other selected values itself.

Call `searchable()` with a function that borrows each item's search text. Paste
uses `insert_str()`. Render with `PickerOptions` and a row function to preserve
product-specific labels and colors. The search cursor stays visible as the query
scrolls horizontally. Search matches text anywhere in a label without distinguishing letter case;
use `identified_by()` for stable selection through filtering and list replacement. The picker does not install an event loop,
choose which modal gets input, or grant permission to execute an action.

`ActionCatalog::new()` rejects duplicate action IDs and shortcuts before lookup.
An action's optional description and typed shortcut also generate its help.
`PickerHelp` uses the same binding catalog as the keyboard handler, with
application-specific words for navigation and confirmation.

The complete example provides data, feeds input, renders a native buffer, and
handles a typed result:

```sh
cargo run -p maestro-ui --example action_picker --locked
```

See the [UI library guide](../ui-rs/README.md) for current-choice selection,
reversible previews, changing result lists, and loading/error states.
