# Codex auth wiring and openai-codex transport

## What we ship today

1. **Startup auth (`codex_auth`)**  
   Reads `CODEX_HOME/auth.json` (default `~/.codex/auth.json`).  
   Exports `OPENAI_CODEX_TOKEN` (and optional account id) into process env when
   unset. Defaults interactive model to `openai-codex/gpt-5.5`.

2. **401 refresh**  
   On auth failure for openai-codex models (HTTP path), re-reads `auth.json`
   once, rebuilds `UnifiedClient`, and retries the request.

3. **Doctor**  
   `codex_login` check + openai-codex `auth_health` when auth.json is present.  
   `codex_app_server` check runs only when the selected provider is
   `openai-codex` / `codex`.

4. **App-server turn transport for `openai-codex/*` (partial)**  
   Native agent routes those models through Codex app-server
   (`thread/start`, `turn/start`) via `agent::CodexAppServerTurnSession`.
   Dynamic tools are registered; `item/tool/call` is handled by Maestro's
   `ToolExecutor` **with the same ActionFirewall as the HTTP path**.
   System / prompt-context instructions are passed as
   `developerInstructions` on `thread/start`.

### Honest limitations (do not oversell)

| Area | Status |
|---|---|
| Dynamic Maestro tools | Implemented with firewall + ToolCall approval UI |
| Codex-native `commandExecution` / `fileChange` approvals | Auto-accept **only in Yolo**; Selective/Safe **decline** (status line). Shell via those RPCs is off unless Yolo |
| Safe approval policy on thread | Mapped to Codex `untrusted` (Selective → `on-request`) |
| Non-text user content | Text blocks only |
| Token usage from app-server | Not yet wired into ResponseEnd |
| Full app-server v2 surface | See issue #3226 |

## Landlock workspace write (Linux)

**Stage-1 (current, secure):**

- Expand existing non-excluded children → full RW.
- Root gets Make*/Remove* only (no WriteFile).
- `.git` is never granted WriteFile (it is skipped during expansion).
- Residual: `printf x > newfile` may create an empty name (MakeReg) while
  content write fails.

**Stage-2 is not expressible with `path_beneath` grants alone.**

Landlock within a layer ORs matching rules; there is no "most specific
wins" deny. WriteFile on the workspace root necessarily covers `.git`.
Real options for true create+write of new root children without `.git`
write:

1. Bind-mount `.git` read-only (or aside) before enforce.
2. Drop the `.git` RO guarantee and document that.
3. Keep stage-1 and accept empty new root names.

Tracked under #3222; do not reintroduce a "most specific path" story.

## Design target

| Provider | Auth | Transport |
|---|---|---|
| `openai` | Platform API key / Platform OAuth | HTTP Responses / Chat Completions |
| `openai-codex` | ChatGPT via Codex app-server | app-server `thread/start`, `turn/start` |

Further protocol surface (thread list/fork/resume, plugins, skills, Code Mode)
is researched in #3226.
