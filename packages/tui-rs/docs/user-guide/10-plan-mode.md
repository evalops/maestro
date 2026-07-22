# Plan Mode

Plan mode asks the agent to plan before performing mutating tool work. It is part of the Normal → Plan → Always-approve mode cycle.

---

## Enable / disable

In the TUI:

```text
/plan
/plan on
/plan off
```

Keyboard: `Shift+Tab` cycles **Normal → Plan → Always-approve**.

Environment:

```bash
export MAESTRO_PLAN_MODE=1
maestro
```

---

## Behavior

When plan mode is active:

- Mutating tools (writes, edits, patch apply, bash that changes the system) are gated so the agent should produce or follow a plan first.
- The safety stack consults plan-mode flags (`is_plan_mode` / `MAESTRO_PLAN_MODE`) alongside safe-mode and require-plan settings.
- Footer / status badges surface plan mode when enabled.
- `/status` and diagnostics reflect the active safety posture.

Plan mode does **not** replace approvals entirely: combine with `/auto`, `/ask`, or `/always-approve` depending on how much confirmation you want (see [Sandbox and Safety](12-sandbox-and-safety.md)).

---

## Related commands

| Command | Role |
|---------|------|
| `/plan [on\|off]` | Toggle plan mode |
| `/approvals …` | YOLO / selective / safe |
| `/always-approve` | YOLO shortcut |
| `/auto` | Selective approvals |
| `/ask` | Approve every tool |

Historical docs also mention todo-style planning integrated with plan workflows (`todo` tool / session plan state). Treat `/plan` as the native switch for plan-before-mutate gating.

---

## Hardened profiles

`MAESTRO_PROFILE=prod` enables safe-mode and plan-required guards among other defaults. Use that for hosted or shared environments; keep local development lenient unless you opt in.
