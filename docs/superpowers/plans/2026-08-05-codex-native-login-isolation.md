# Codex native-login credential isolation

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let `openai-codex/*` native turns use Codex app-server's own ChatGPT login without copying `CODEX_HOME/auth.json` access tokens into Maestro's HTTP-client environment.

**Scope:** Keep the existing `maestro codex login/status/logout` surface and app-server transport. Change only the native-agent credential boundary, model switching, default-model discovery, and the side-question path needed to keep Codex-native behavior coherent. Preserve direct-provider auth resolution for non-Codex models.

## Plan

### 1. Separate auth discovery from direct-provider credential injection

- Make default-model resolution read the Codex auth snapshot without mutating process environment.
- Remove unconditional startup injection from interactive, print, and doctor paths.
- Retain the existing environment application only for non-Codex direct-provider construction, including API-key mode.

### 2. Make the native runner app-server-only for Codex models

- Resolve no `UnifiedClient` for `openai-codex/*` and equivalent Codex model ids when no caller-provided client override exists.
- Store the direct client as optional, because app-server turns do not use it.
- Update model changes, request configuration, and direct HTTP loops to handle the two transport modes explicitly.
- Remove the obsolete Codex HTTP-client refresh path so token rotation remains owned by Codex app-server.

### 3. Preserve side questions through Codex app-server

- Run Codex-native side questions in an isolated, tool-free app-server session using the current provider-visible history.
- Reject any unexpected server tool/approval request rather than falling back to a direct HTTP client or executing tools.
- Keep the existing direct-provider side-question implementation unchanged for non-Codex models.

### 4. Verify the boundary

- Add unit coverage proving Codex client resolution succeeds without a Codex token environment variable and returns the app-server provider identity.
- Add/adjust auth tests proving default-model discovery does not export the ChatGPT access token.
- Run formatting, targeted `tui-rs` tests, and the relevant workspace checks; record any environment blockers separately.

### 5. Publish

- Inspect the exact diff and current `origin/main` before commit.
- Commit the focused change on `agent/codex-native-login-isolation`, push it, open a ready-for-review PR, and wait for required protected checks.
- Merge only through normal GitHub protection after the exact pushed head is green; do not bypass queued or unavailable checks.
