# Prompt Queue & Loader Lifecycle

When multiple prompts arrive faster than the agent can respond, Composer queues
them and surfaces progress via the loader/notification system. This doc explains
how the queue works and how the loader visualizes each stage.

## Queue Mechanics

`src/cli-tui/prompt-queue.ts` implements a simple FIFO queue:

- Each queued prompt has an `id`, `text`, and `createdAt`.
- Events (`enqueue`, `start`, `finish`, `cancel`, `error`) are broadcast to
  subscribers (e.g., notifications, footer hints).
- Only one prompt runs at a time (`runner` function). When it finishes, the next
  prompt dequeues automatically.

### User Controls

- `/queue` – list pending prompts, showing IDs and trimmed text.
- `/queue cancel <id>` – remove a pending prompt.
- `/queue clear` (planned) – drop all pending prompts.
- Footer hint shows “N prompts queued” whenever `pending.length > 0`.

## Loader Stages

`src/cli-tui/loader-stage-manager.ts` tracks the current phase:

1. **Planning** – initial tool planning (always the first stage)
2. **Tool · <name>** – each tool invocation inserts its own stage
3. **Responding** – final LLM response (only once tools are done)

Stage metadata feeds into `Loader` (`src/cli-tui-lib/components/loader.ts`), which
now uses a subtle dot animation instead of the prior intense wave. The loader
shows:

- Title (“Active tasks”)
- Current stage label + step counter (e.g., “Tool · read (2/3)”)
- Hint (“esc to interrupt”)
- A breathing spinner (single dot) and a muted progress bar or three-dot indicator

When the agent streams tokens (`setStreamingActive(true)`), the loader transitions
to Responding once all tool stages finish or if there were no tools.

## Notifications

Prompt queue events trigger notifications via `src/cli-tui/run-controller.ts` and
`NotificationView`:

- Enqueue (when not immediate) → “Queued prompt #<id>”
- Cancel → “Removed queued prompt #<id>”
- Error → toast with the failure

This keeps users informed even if they’re not staring at the loader.

## Interrupts

- `Esc` once arms an interrupt; pressing `Esc` again within 5 s aborts the current run.
- Ctrl+C clears the editor (double Ctrl+C exits).
- Interrupts cancel the active prompt (it will emit `error` with “aborted”), and
  the queue proceeds to the next entry.
