# Session Storage & Continuation

Composer persists conversation history in JSONL files under
`~/.composer/agent/sessions/--<cwd>--`. Understanding the format helps when you
want to inspect, back up, or clean up sessions.

## Directory Layout

```
~/.composer/agent/
└─ sessions/
   └─ --Users-me-project--/
      ├─ 2025-01-15T18-05-23.982Z_<uuid>.jsonl
      └─ ...
```

The `--<cwd>--` naming is derived from your project path with slashes replaced
by dashes, so different repos never collide.

## JSONL Format

Each line is a JSON object describing a session event:

```json
{ "type": "session", "id": "uuid", "timestamp": "...", "cwd": "...", "model": "anthropic/claude-sonnet-4-5" }
{ "type": "message", "timestamp": "...", "message": { "role": "user", "content": "..." } }
{ "type": "thinking_level_change", "timestamp": "...", "thinkingLevel": "deep" }
{ "type": "model_change", "timestamp": "...", "model": "openai/gpt-4o", "modelMetadata": { ... } }
{ "type": "session_meta", "timestamp": "...", "summary": "..." }
```

Important types:

- `session` – header entry with model + cwd
- `message` – serialized `AppMessage` (user, assistant, tool result, etc.)
- `thinking_level_change` – records `/thinking` adjustments
- `model_change` – tracks mid-session provider/model switches
- `session_meta` – favorites, manual summaries, future metadata

## CLI Flags

| Flag            | Effect                                       |
| --------------- | --------------------------------------------- |
| `--continue`    | Load the most recent session for the cwd     |
| `--resume`      | Interactive picker of existing sessions      |
| `--session path`| Use a specific JSONL file (absolute or relative) |
| `--no-session`  | Disable persistence entirely for this run    |

The TUI also offers `/sessions` to list + load by index. When loading, the agent
replays the stored messages into its state and restores model/thinking settings.

## Favorites & Summaries

`session_meta` entries can include `favorite: true` or a `summary` string. Add
these without touching the JSONL by using:

- `/session favorite` or `/session unfavorite` to toggle the active session
- `/session summary "<text>"` to attach a manual blurb to the active session
- `/sessions summarize <number>` to auto-summarize a saved session by index

## Cleaning Up

- Delete the `--<cwd>--` directory to wipe all sessions for a repo.
- Use `--no-session` in CI or ephemeral workspaces to avoid clutter.

Future enhancements (continuous context, shared KBs) will reuse this directory,
so keep it tidy but don’t remove unrelated files under `~/.composer/agent/`.
