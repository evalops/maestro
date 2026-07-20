# Prompt Queue & Loader Lifecycle

When multiple prompts arrive faster than the agent can respond, Maestro queues
them and surfaces progress in the native TUI. This doc explains how the queue
works in the current interactive surface.

> **Historical note:** The TypeScript implementations
> (`src/cli-tui/prompt-queue.ts`, `loader-stage-manager.ts`, `run-controller.ts`)
> were removed with the TS TUI in PR
> [#2891](https://github.com/evalops/maestro-internal/pull/2891). Interactive
> queuing lives in `packages/tui-rs`.

## Queue mechanics (native maestro-tui)

Primary code: [`packages/tui-rs/src/app/prompt_queue.rs`](../packages/tui-rs/src/app/prompt_queue.rs)
(wired from `app.rs`).

- Prompts are FIFO with kinds such as **FollowUp** and **Steer**.
- While a turn is busy, new input can be queued or steered depending on mode.
- Each queued entry has an `id`, `content`, and `kind`.
- Steer messages can insert toward the front of the queue; follow-ups append.
- A max pending capacity drops the oldest entry when the queue is full.

### User controls

| Input / command | Behavior |
|-----------------|----------|
| `Enter` while running | Steer (interrupt/guide active run) when allowed |
| `Alt+Enter` while running | Queue a follow-up |
| `/queue` | Inspect queue / modes (see slash help in TUI) |
| Footer / status | Shows queue full or mode-blocked messages |

Modes such as one-at-a-time vs allow-all for follow-up and steer are enforced in
the App handlers (messages like “Follow-up mode set to one-at-a-time…”).

## Loader / busy UI

Native UI status is driven by App state (busy flag, status line, thinking and
tool indicators under `packages/tui-rs/src/components/`), not the removed
TypeScript `Loader` component. Stages are reflected through:

- Thinking / spinner indicators while the agent is active
- Tool execution surfaces in the chat view
- Status strings for queue and mode feedback

## Notifications

Queue outcomes surface as status or toast-style messages in the native App
(for example queue-full drops). There is no separate `NotificationView` path
from the old TS tree.

## Interrupts

- `Esc` / `Ctrl+C` cancel or interrupt according to native key bindings
  (see [packages/tui-rs/README.md](../packages/tui-rs/README.md)).
- Interrupting the active prompt does not necessarily discard already-queued
  follow-ups; queue drain continues according to App logic.

## Related

- [TUI Architecture](TUI_ARCHITECTURE.md)
- [Native TUI parity](NATIVE_TUI_PARITY.md)
- [Features](FEATURES.md)
