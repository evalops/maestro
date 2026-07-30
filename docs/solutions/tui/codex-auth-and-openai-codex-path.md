# Codex auth wiring and openai-codex transport

## What we ship today

1. **Startup auth (`codex_auth`)**  
   Reads `CODEX_HOME/auth.json` (default `~/.codex/auth.json`).  
   Exports `OPENAI_CODEX_TOKEN` (and optional account id) into process env when
   unset. Defaults interactive model to `openai-codex/gpt-5.5`.

2. **401 refresh**  
   On auth failure for openai-codex models, re-reads `auth.json` once, rebuilds
   `UnifiedClient`, and retries the request.

3. **Doctor**  
   `codex_login` check + openai-codex `auth_health` when auth.json is present.

## Design target (app-server)

`docs/MODELS.md` separates:

| Provider | Auth | Transport |
|---|---|---|
| `openai` | Platform API key / Platform OAuth | HTTP Responses / Chat Completions |
| `openai-codex` | ChatGPT via Codex app-server | app-server `thread/start`, `turn/start` |

Native agent today uses **HTTP `UnifiedClient`** with the Codex token as
Bearer. That unblocks agent startup after `maestro codex login`. The long-term
path is routing `openai-codex/*` through `packages/tui-rs/src/codex_app_server.rs`
(and control-plane `codex_bridge`) so token refresh stays owned by Codex and
subscription semantics match the product docs.

### Follow-up work

- [ ] Native agent transport branch: if model provider is openai-codex, run
      turns via CodexAppServerClient instead of UnifiedClient.
- [ ] Map tool calls / approvals through app-server events.
- [ ] Stop treating ChatGPT access tokens as generic OpenAI API keys once
      app-server path is default.

## Landlock stage-2 (sandbox)

Stage-1 grants `Make*`/`Remove*` on the workspace root without `WriteFile`, so
new root names may appear empty while content writes fail (see sandbox tests).

Stage-2 goal: nested rulesets that allow create+write for new root children
without reopening write access to existing `.git` contents. Not implemented in
this train; tracked as follow-up after stage-1 residual notes in
`packages/tui-rs/src/sandbox.rs`.
