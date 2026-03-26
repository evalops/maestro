# Composer Comprehensive Backlog

Generated from a fresh repo audit on `2026-03-13` across the current approvals/evals work, the web/server surface, core agent/provider infrastructure, desktop/TUI/CLI UX, and the existing TODO/FIXME/skip inventory.

Execution rules:

- Tackle `P0` and `P1` first.
- Keep `bun run bun:lint`, `npx nx run maestro:test --skip-nx-cache`, and `npx nx run maestro:evals --skip-nx-cache` green after each batch.
- Treat live LLM-judge runs as local/manual validators, not CI-required defaults.
- Update this file as work lands.

Legend:

- `P0` = security / correctness / production breakage
- `P1` = high-value parity / resilience / validation
- `P2` = polish / follow-up hardening

## 1. Web, server, auth, and approval-flow backlog

- [ ] 1. `P0` Introduce declarative route auth/CSRF enforcement — `src/server/routes.ts`, `src/server/server-middlewares.ts`, `src/server/authz.ts` — auth is currently scattered across handlers.
- [ ] 2. `P0` Add `requireApiAuth()` to session CRUD/share/export — `src/server/handlers/sessions.ts` — ownership checks exist, but JWT/shared-secret auth is not consistently required.
- [ ] 3. `P0` Add ownership checks to session attachment bytes/extract — `src/server/handlers/session-attachments.ts` — current handlers trust the session ID alone.
- [ ] 4. `P0` Add ownership checks to all artifact endpoints — `src/server/handlers/session-artifacts.ts` — artifact index/file/viewer/events/zip should not be session-ID-only access.
- [ ] 5. `P0` Protect workspace/usage snapshots with auth — `src/server/handlers/status.ts`, `src/server/handlers/stats.ts`, `src/server/handlers/usage.ts` — these leak cwd, git, task, and usage state.
- [ ] 6. `P0` Protect config/model/tool/file/command/bridge/MCP discovery endpoints with auth — `src/server/handlers/config.ts`, `models.ts`, `tools.ts`, `files.ts`, `commands.ts`, `bridge.ts`, `mcp.ts` — runtime capability enumeration should not be public in secure deployments.
- [ ] 7. `P0` Add auth + CSRF to runtime preference endpoints — `src/server/handlers/mode.ts`, `framework.ts`, `telemetry.ts`, `training.ts`, `background.ts` — these POST routes mutate runtime/user state.
- [ ] 8. `P0` Add auth + CSRF to execution/mutation endpoints — `src/server/handlers/run.ts`, `workflow.ts`, `automations.ts`, `memory.ts`, `quota.ts`, `cost.ts`, `ollama.ts`, `composer.ts` — command execution and persistent writes must be gated.
- [ ] 9. `P0` Add auth + CSRF to approval/client-tool callbacks — `src/server/handlers/approval.ts`, `client-tools.ts`, `approvals.ts` — request IDs and tool-call IDs alone are not enough.
- [ ] 10. `P0` Lock down Guardian and admin maintenance routes — `src/server/handlers/guardian.ts`, `admin.ts` — these routes can trigger maintenance or sensitive inspection operations.
- [ ] 11. `P0` Gate `/debug/z` behind auth or internal-only config — `src/server/routes.ts`, `src/server/server-middlewares.ts` — the route is intentionally left open today.
- [ ] 12. `P0` Decide whether `/api/metrics` should remain public — `src/server/routes.ts`, `src/server/server-middlewares.ts` — if not, add auth or allowlisting.
- [x] 13. `P0` Make shared attachment downloads honor share-access semantics — `src/server/handlers/sessions.ts`, `test/shared-session-attachments-endpoints.test.ts` — tokenized attachment access currently weakens `maxAccesses` semantics.
- [x] 14. `P0` Rate-limit shared attachment downloads — `src/server/handlers/sessions.ts`, `test/share-rate-limit.test.ts`, `test/shared-session-attachments-endpoints.test.ts` — shared-session access is rate-limited, but shared-attachment fetch is not.
- [ ] 15. `P0` Harden the artifact viewer popup bridge — `src/server/handlers/session-artifacts.ts` — `open-external-url` messages should validate origin/source.
- [x] 16. `P1` Expand CORS allow-headers for real web clients — `src/server/server-utils.ts`, `test/web/web-server-components.test.ts` — several Composer-specific headers are still omitted.
- [x] 17. `P1` Add centralized auth/API-key/CSRF header injection to `ApiClient` — `packages/web/src/services/api-client.ts` — the web client still assumes same-origin/no-auth.
- [x] 18. `P1` Stop auxiliary components from creating their own default API clients — `packages/web/src/components/composer-input.ts`, `model-selector.ts`, `composer-chat.ts` — they bypass shared auth/session config.
- [x] 19. `P1` Make attachment viewing/extraction auth-aware — `packages/web/src/components/composer-attachment-viewer.ts`, `packages/web/src/services/api-client.ts` — raw `fetch()` paths break secure deployments.
- [x] 20. `P1` Make artifact open/download flows auth-aware — `packages/web/src/components/composer-artifacts-panel.ts`, `packages/web/src/services/api-client.ts`, `src/server/handlers/session-artifacts.ts`, `src/server/artifact-access.ts` — current new-tab/download URLs cannot carry auth.
- [x] 21. `P1` Route policy validation through an auth-aware client — `packages/web/src/components/admin-policy-tab.ts`, `packages/web/src/services/enterprise-api.ts` or `api-client.ts` — the current POST is a bare `fetch()`.
- [x] 22. `P1` Solve browser WebSocket auth or auto-disable WS when auth needs headers — `packages/web/src/services/api-client.ts`, `src/server/handlers/chat-ws.ts` — browser WS cannot send the same auth headers as `fetch`.
- [x] 23. `P1` Add an auth-aware bootstrap for artifact live-reload/EventSource — `src/server/handlers/session-artifacts.ts`, `packages/web/src/components/composer-artifacts-panel.ts`, `src/server/artifact-access.ts` — `EventSource` cannot send custom headers either.
- [x] 24. `P1` Handle `error` / `aborted` agent events in the chat UI — `packages/web/src/components/composer-chat.ts`, `packages/web/src/components/composer-chat-stream-handling.test.ts` — the main event switch still under-handles failure signals.
- [x] 25. `P1` Preserve structured composer error payloads for chat setup failures — `packages/web/src/services/api-client.ts`, `test/web/api-client-error.test.ts`, `packages/web/src/services/api-client.chat.test.ts` — `/api/chat` failures still collapse to generic messages too often.
- [x] 26. `P1` Make chat streaming use fallback base URLs too — `packages/web/src/services/api-client.ts`, `packages/web/src/services/api-client.fallback.test.ts` — fallback logic exists for JSON requests, not chat bootstrapping.
- [ ] 27. `P1` Add reconnect/recovery for pending approvals after stream loss — `src/server/approval-store.ts`, `src/server/handlers/approvals.ts`, `packages/web/src/components/composer-chat.ts` — dropped streams can strand approvals server-side.
- [x] 28. `P1` Stop clearing the local approval queue on generic send errors — `packages/web/src/components/composer-chat.ts` — the UI may discard approvals the server still expects.
- [ ] 29. `P1` Add route-auth regression tests — `test/web/route-auth-coverage.test.ts`, `src/server/routes.ts` — we need a failing test when secure-sensitive routes skip auth.
- [x] 30. `P1` Add shared-attachment regression tests for max-access/rate-limit behavior — `test/shared-session-attachments-endpoints.test.ts`, `test/share-rate-limit.test.ts` — current shared attachment behavior needs stronger guarantees.
- [ ] 31. `P1` Drive web slash commands from `/api/commands` instead of a static list — `packages/web/src/components/slash-commands.ts`, `composer-input.ts`, `command-drawer.ts`, `composer-chat-slash-commands.ts`, `packages/web/src/services/api-client.ts`, `src/server/handlers/commands.ts` — custom commands are server-side only today.
- [ ] 32. `P1` Hide or clearly mark unsupported slash commands — `packages/web/src/components/slash-commands.ts`, `composer-chat-slash-commands.ts`, `command-drawer.ts`, `composer-input.ts` — several commands are advertised but stubbed.
- [ ] 33. `P1` Autofocus the command palette search and restore focus on close — `packages/web/src/components/command-drawer.ts`, `composer-chat.ts` — keyboard-first command use is still awkward.
- [ ] 34. `P1` Add error/loading handling around `@` file lookup — `packages/web/src/components/composer-input.ts`, `packages/web/src/services/api-client.ts` — file search failures currently surface poorly.
- [ ] 35. `P1` Refresh file suggestions after workspace mutations — `src/utils/workspace-files.ts`, `src/server/handlers/files.ts`, `packages/web/src/components/composer-input.ts` — `@` results become stale after create/delete/rename operations.
- [ ] 36. `P1` Move first-time file loading off the synchronous input path — `packages/web/src/components/composer-input.ts` — awaiting `getFiles()` during input handling adds first-use lag.
- [ ] 37. `P1` Expose session rename/tags/favorite in the web sidebar — `src/server/handlers/sessions.ts`, `packages/web/src/services/api-client.ts`, `packages/web/src/components/composer-session-sidebar.ts`, `composer-chat.ts` — the API exists but the web UI still lags.
- [ ] 38. `P1` Add read-only artifact browsing/downloading to shared sessions — `packages/web/src/components/composer-chat.ts`, `composer-artifacts-panel.ts`, `src/server/handlers/sessions.ts` or `session-artifacts.ts` — shared viewers still lack full artifact parity.
- [ ] 39. `P2` Hide or gate the Admin Settings entry when enterprise auth/DB isn’t active — `packages/web/src/components/composer-chat.ts`, `packages/web/src/components/admin-settings.ts`, `src/server/handlers/status.ts` — the shield icon is always visible.
- [ ] 40. `P2` Replace fake admin defaults with explicit unavailable/auth-required states — `packages/web/src/components/admin-settings.ts`, `test/web-admin.test.ts` — mock values are misleading in real deployments.

## 2. Core agent, provider, safety, eval, and CI backlog

- [ ] 41. `P1` Add focused tests for message normalization helpers — `src/agent/agent.ts`, `src/agent/custom-messages.ts`, `test/agent/*` — helper behavior shapes every provider request and still lacks direct coverage.
- [ ] 42. `P1` Cover `AutoRetryController` end-to-end — `src/agent/auto-retry.ts`, `test/agent/*` — retry delay parsing, abort semantics, and cleanup are not directly tested.
- [ ] 43. `P1` Test transcript persistence and ordering — `src/agent/agent-resume.ts`, `test/agent/*` — load/list/delete semantics are unpinned.
- [ ] 44. `P1` Test checkpoint lifecycle and retention — `src/agent/session-checkpoint.ts`, `test/agent/*` — auto timers, pruning, and latest-checkpoint resolution need explicit coverage.
- [ ] 45. `P1` Add routing tests for smart model selection — `src/agent/smart-model-router.ts`, `test/agent/*` — signal scoring and preset switching remain under-tested.
- [ ] 46. `P1` Test provider dispatch glue — `src/agent/transport/create-provider-stream.ts`, `test/agent/*` — provider/reasoning dispatch should be directly asserted.
- [ ] 47. `P1` Exercise tool-safety and transport orchestration branches — `src/agent/transport/tool-safety-pipeline.ts`, `src/agent/transport.ts`, `test/agent/*` — hook-mutated input, approval-required, and anomaly paths need coverage.
- [ ] 48. `P1` Tighten Responses API schema filtering to require root object schemas — `src/agent/providers/openai-shared.ts`, `evals/openrouter/compat-cases.json`, `test/agent/*` — non-object roots can still sneak through.
- [ ] 49. `P1` Add Mistral-specific request-shaping tests — `src/agent/providers/openai.ts`, `test/agent/openai-streaming.test.ts` — compat branches remain lightly covered.
- [ ] 50. `P1` Add OpenRouter Claude request-body regressions — `src/agent/providers/openai.ts`, `test/agent/openai-streaming.test.ts`, `test/agent/openai-compat.test.ts` — cache control and role shaping should be pinned.
- [ ] 51. `P1` Expand compat corpus beyond current providers — `src/agent/providers/openai.ts`, `scripts/evals/openrouter-compat/core.ts`, `evals/openrouter/compat-cases.json` — xAI, Cerebras, Chutes, Azure, and proxy URL coverage is still partial.
- [ ] 52. `P1` Add direct Gemini CLI provider tests — `src/agent/providers/google-gemini-cli.ts`, `test/agent/*` — token/project parsing and multimodal branches need dedicated coverage.
- [ ] 53. `P1` Expand Google and Vertex streaming coverage — `src/agent/providers/google.ts`, `src/agent/providers/vertex.ts`, `test/agent/google-streaming.test.ts`, `test/agent/vertex-streaming.test.ts` — current coverage is extremely narrow.
- [ ] 54. `P1` Expand Anthropic streaming coverage — `src/agent/providers/anthropic.ts`, `test/agent/anthropic-streaming.test.ts` — thinking, usage accounting, stop reasons, and richer tool-result flows should be asserted.
- [ ] 55. `P1` Assert manual model overlays exhaustively — `src/models/builtin.ts`, `test/models/model-registry.test.ts` — many manual overlays still have no direct tests.
- [ ] 56. `P1` Add Factory integration tests — `src/models/factory-integration.ts`, `test/models/*` or `test/config/*` — provider dedupe, key precedence, and default selection need coverage.
- [ ] 57. `P1` Add models.dev cache tests — `src/models/models-dev.ts`, `test/models/*` — expired cache, corrupt cache, timeout, and background refresh behavior remains untested.
- [ ] 58. `P1` Expand URL normalization edge cases — `src/models/url-normalize.ts`, `src/agent/providers/openai.ts`, `test/url-normalize.test.ts`, `test/agent/resolve-openai-url.test.ts` — query/fragment/upstream permutations still have gaps.
- [ ] 59. `P1` Expand `ActionApprovalService` tests beyond mode toggling — `src/agent/action-approval.ts`, `test/safety/action-approval.test.ts` — queueing, resolution, and abort behavior are still uncovered.
- [ ] 60. `P1` Add direct nested-agent guard tests — `src/safety/nested-agent-guard.ts`, `test/safety/*` — env-depth and loop-protection logic needs explicit coverage.
- [ ] 61. `P1` Add direct tool rate-limiter tests — `src/safety/rate-limiter.ts`, `test/safety/*` — cooldowns, overrides, and disabled mode need protection.
- [ ] 62. `P1` Add direct credential-store tests — `src/safety/credential-store.ts`, `test/safety/*` — dedupe, recursive resolution, stats, and clear behavior are only indirectly tested.
- [ ] 63. `P1` Expand path-containment edge-case coverage — `src/safety/path-containment.ts`, `test/safety/system-paths.test.ts`, `test/safety/action-firewall-*.test.ts` — trusted paths, macOS variants, and temp roots need more coverage.
- [ ] 64. `P1` Expand approvals handler/store error-path tests — `src/server/handlers/approvals.ts`, `src/server/approval-mode-store.ts`, `test/web/approvals-handler.test.ts` — current tests are mostly happy-path.
- [ ] 65. `P1` Add negative approval-flow eval cases — `evals/approvals/flow-cases.json`, `scripts/evals/approvals-flow/core.ts`, `test/evals/approvals-flow-evals.test.ts` — invalid payloads and invalid modes are missing.
- [ ] 66. `P1` Broaden firewall regression scenarios — `src/safety/action-firewall.ts`, `scripts/run-firewall-eval.js`, `evals/scenarios.json` — current scenario coverage is too small.
- [ ] 67. `P1` Test context-firewall vault-vs-block behavior explicitly — `src/safety/context-firewall.ts`, `src/safety/credential-store.ts`, `src/agent/transport/tool-safety-pipeline.ts`, `test/safety/context-firewall.test.ts` — masking/vaulting branches should be pinned directly.
- [ ] 68. `P1` Add direct tests for the eval runner — `scripts/run-evals.js`, `test/evals/*` — chunk parsing, regex matching, timeouts, and stderr handling need direct coverage.
- [x] 69. `P1` Generalize eval verification beyond one scenario — `scripts/verify-evals.js`, `evals/scenarios.json` — scenario verification is still too shallow.
- [x] 70. `P1` Make live smoke require exact sentinel equality — `scripts/evals/run-openrouter-live-smoke.ts`, `test/evals/*` — current behavior passes on substring inclusion only.
- [ ] 71. `P1` Expand LLM-judge core tests — `scripts/evals/llm-judge/core.ts`, `test/evals/llm-judge-core.test.ts` — env parsing, prompt-only fallback, schema-name generation, and invalid model/API errors need direct coverage.
- [ ] 72. `P1` Exercise real multi-vote judge behavior — `scripts/evals/llm-judge/core.ts`, `scripts/evals/run-openrouter-approvals-judge-evals.ts`, `scripts/evals/run-openrouter-tool-surface-judge-evals.ts` — majority-vote machinery is still lightly battle-tested.
- [ ] 73. `P1` Persist judge/live failure artifacts — `scripts/evals/llm-judge/core.ts`, `scripts/evals/shared.ts`, workflow artifact steps — stdout alone is not enough for debugging judge failures.
- [x] 74. `P1` Add first-class package/Nx entrypoints for judge/live suites — `package.json`, `project.json`, `scripts/evals/run-openrouter-live-smoke.ts`, `scripts/evals/run-openrouter-approvals-judge-evals.ts`, `scripts/evals/run-openrouter-tool-surface-judge-evals.ts` — these runners need repo-standard entrypoints.
- [ ] 75. `P1` Hermeticize mutating scenario helpers — `scripts/run-diff-tool.js`, `scripts/run-edit-tool.js`, `scripts/run-write-tool.js`, `scripts/run-todo-tool.js`, `scripts/run-evals.js` — local state pollution hurts determinism.
- [ ] 76. `P1` Disable Nx cache for evals in CI — `nx.json`, `project.json`, `.github/workflows/evals.yml` — future live/judge/network behavior should not be cacheable.
- [ ] 77. `P1` Deduplicate shard/chunk counts across workflows — `.github/workflows/evals.yml`, `.github/workflows/release.yml`, `scripts/run-evals.js` — hard-coded shard counts are easy to desync.
- [ ] 78. `P1` Make release quality gates match the documented repo standard — `.github/workflows/release.yml`, `package.json` — release validation is narrower than repo guidance.
- [ ] 79. `P1` Broaden PR build coverage to package surfaces — `.github/workflows/ci.yml`, `package.json`, `project.json` — root build alone is not enough for package drift.
- [ ] 80. `P1` Add a secret-gated scheduled/manual live+judge workflow — `.github/workflows/evals.yml` or a new workflow, `scripts/evals/run-openrouter-live-smoke.ts`, `scripts/evals/run-openrouter-*-judge-evals.ts` — the new live judge infrastructure still has no workflow hook.

## 3. Desktop, TUI, CLI, and UX backlog

- [ ] 81. `P1` Preserve `system` theme selection in desktop settings — `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/renderer/components/Settings/SettingsModal.tsx`, `packages/desktop/src/renderer/components/Settings/AppearanceSection.tsx` — reopening Settings currently loses whether the user chose `System`.
- [ ] 82. `P1` Extract `SettingsModal` data-loading/mutation logic into a hook/controller — `packages/desktop/src/renderer/components/Settings/SettingsModal.tsx`, `packages/desktop/src/renderer/lib/api-client.ts` — orchestration remains centralized and brittle.
- [ ] 83. `P1` Add integration tests for `SettingsModal` orchestration — `packages/desktop/src/renderer/components/Settings/SettingsModal.tsx`, `test/desktop/*` — section view-model coverage is not enough.
- [ ] 84. `P1` Make Preferences shortcut parity real on Windows/Linux — `packages/desktop/src/main/menu.ts`, `packages/desktop/README.md` — the README promises `Cmd/Ctrl+,`, but only macOS gets Preferences.
- [ ] 85. `P1` Replace the hardcoded Model menu with the real model inventory — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/renderer/hooks/useComposer.ts`, `packages/desktop/src/renderer/components/Header/Header.tsx` — the native menu still hardcodes three Anthropic choices.
- [ ] 86. `P1` Wire `menu:select-model` to an actual selector flow — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/components/Header/Header.tsx` — the event is emitted but the renderer does nothing.
- [ ] 87. `P1` Implement “Export Session…” from the native menu — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/lib/api-client.ts` — the plumbing stops before the renderer.
- [ ] 88. `P1` Implement “Share Session…” from the native menu — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/renderer/App.tsx` — the event exists with no implementation.
- [ ] 89. `P1` Implement “Clear Context” from the native menu — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/hooks/useChat.ts` — `Cmd/Ctrl+K` is still a dead menu action.
- [ ] 90. `P1` Implement Find/focus-search from the native menu — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/components/Sidebar/Sidebar.tsx` — `menu:find` is emitted with no focus behavior.
- [ ] 91. `P1` Add a desktop shortcut/help surface and wire `menu:show-shortcuts` — `packages/desktop/src/main/menu.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/renderer/App.tsx` — Help advertises shortcuts that the renderer never shows.
- [ ] 92. `P1` Make the attachment button real or remove it until supported — `packages/desktop/src/renderer/components/Chat/InputArea.tsx`, `packages/desktop/src/preload/index.ts` — the desktop UI still shows a dead attachment affordance.
- [ ] 93. `P1` Refresh MCP tool suggestions after runtime changes — `packages/desktop/src/renderer/components/Chat/InputArea.tsx`, `packages/desktop/src/renderer/components/Settings/ToolsRuntimeSection.tsx` — tool suggestions are loaded once and then go stale.
- [ ] 94. `P1` Thread `AbortSignal` through desktop streaming and add a stop-generation control — `packages/desktop/src/renderer/hooks/useChat.ts`, `packages/desktop/src/renderer/lib/api-client.ts`, `packages/desktop/src/renderer/components/Chat/ChatContainer.tsx` — the desktop chat cannot actually cancel in-flight fetches yet.
- [ ] 95. `P1` Surface live tool execution in desktop chat — `packages/desktop/src/renderer/hooks/useChat.ts`, `packages/desktop/src/renderer/lib/types.ts`, `packages/desktop/src/renderer/components/Chat/Message.tsx`, `packages/desktop/src/renderer/components/Chat/ToolCall.tsx` — desktop message UI supports tool calls, but the stream hook still underfeeds it.
- [ ] 96. `P2` Stop truncating expanded tool results at 1000 chars — `packages/desktop/src/renderer/components/Chat/ToolCall.tsx` — users still cannot inspect complete tool output after expansion.
- [ ] 97. `P1` Clear old messages immediately when switching sessions — `packages/desktop/src/renderer/hooks/useChat.ts`, `packages/desktop/src/renderer/components/Chat/ChatContainer.tsx` — prior-session content can flash while the new session loads.
- [ ] 98. `P1` Fix keyboard dismissal/focus management in the header model dropdown — `packages/desktop/src/renderer/components/Header/Header.tsx` — the overlay does not take focus properly.
- [ ] 99. `P1` Fix session-row action accessibility in the sidebar — `packages/desktop/src/renderer/components/Sidebar/Sidebar.tsx`, `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/hooks/useComposer.ts` — nested button semantics and hover-only delete are still problematic.
- [ ] 100. `P2` Replace the hardcoded desktop version badge with the actual app version — `packages/desktop/src/renderer/components/Sidebar/Sidebar.tsx`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/main/ipc.ts` — the footer version literal will drift.
- [ ] 101. `P1` Add renderer-level regression tests for app/menu/chat flows — `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/renderer/hooks/useChat.ts`, `packages/desktop/src/renderer/hooks/useComposer.ts`, `test/desktop/*` — the highest-risk renderer behavior remains largely untested.
- [ ] 102. `P1` Add a real `/safety` alias or rename `/safe` — `src/cli-tui/commands/registry.ts`, `src/cli-tui/commands/grouped/safety-commands.ts`, `test/tui/tui-grouped-commands.test.ts` — handler docs and registry names still disagree.
- [ ] 103. `P1` Make `/thinking <level>` actually apply the requested level — `src/cli-tui/commands/registry.ts`, `src/cli-tui/utils/commands/command-registry-builder.ts`, `src/cli-tui/tui-renderer/command-registry-options.ts`, `src/cli-tui/selectors/thinking-selector-view.ts` — the argument is parsed but ignored.
- [ ] 104. `P1` Unify thinking-level taxonomy across TUI, desktop, and agent mapping — `src/agent/types.ts`, `src/agent/agent.ts`, `src/cli-tui/selectors/thinking-selector.ts`, `src/cli-tui/tui-renderer/quick-settings-controller.ts`, `src/cli-tui/commands/registry.ts`, `packages/desktop/src/renderer/components/Settings/ModelReasoningSection.tsx` — `high`, `max`, and `ultra` still drift.
- [ ] 105. `P1` Extend quick-settings cycling to the full supported thinking range — `src/cli-tui/tui-renderer/quick-settings-controller.ts`, `src/cli-tui/selectors/thinking-selector.ts` — quick settings still cannot reach the full level set.
- [ ] 106. `P1` Centralize shortcut metadata and fix current Ctrl+K drift — `src/cli-tui/custom-editor.ts`, `src/cli-tui/editor-view.ts`, `src/cli-tui/hotkeys-view.ts`, `src/cli-tui/instruction-panel.ts`, `src/cli-tui/startup-announcements.ts` — shortcut copy is duplicated and already drifting.
- [ ] 107. `P1` Let users type `f` and `?` into the command-palette filter — `src/cli-tui/utils/commands/command-palette.ts`, `test/tui/command-palette-component.test.ts` — filterable characters currently collide with command shortcuts.
- [ ] 108. `P1` Add unit coverage for `QuickSettingsController` — `src/cli-tui/tui-renderer/quick-settings-controller.ts`, `test/tui/*` — core keyboard shortcuts still lack direct tests.
- [ ] 109. `P1` Add regression coverage for editor-binding precedence — `src/cli-tui/custom-editor.ts`, `src/cli-tui/tui-renderer/editor-bindings.ts`, `test/tui/*` — overlapping keybindings need stronger protection.
- [ ] 110. `P1` Add coverage for `CommandPaletteView` modal lifecycle/insertion — `src/cli-tui/utils/commands/command-palette-view.ts`, `test/tui/*` — open/close/insertion behavior remains untested.
- [ ] 111. `P1` Add coverage for `SlashHintController` persistence/cycling behavior — `src/cli-tui/tui-renderer/slash-hint-controller.ts`, `test/*` — recents, favorites, and refresh logic are not directly asserted.
- [ ] 112. `P2` Add coverage for hotkeys/help surfaces — `src/cli-tui/hotkeys-view.ts`, `src/cli-tui/instruction-panel.ts`, `test/tui/*` — these copy-heavy surfaces still have no direct tests.
- [ ] 113. `P1` Make `/run` workspace-aware for Bun + Nx — `src/cli-tui/run/run-command-view.ts`, `README.md`, `AGENTS.md` — contributor guidance is monorepo/Bun/Nx-first, but `/run` still assumes `npm run`.
- [ ] 114. `P1` Expand `/run` completions beyond the root `package.json` and add regression coverage — `src/cli-tui/run/run-command-view.ts`, workspace manifests, `test/tui/*` — monorepo scripts are still invisible.
- [ ] 115. `P1` Invalidate the workspace file index after mutations and add freshness tests for `@` search — `src/utils/workspace-files.ts`, `src/cli-tui/search/file-search-view.ts`, `src/cli-tui/smart-autocomplete-provider.ts`, `src/cli-tui/git/git-view.ts`, `test/tui/*` — file caches lag behind writes and renames.
- [ ] 116. `P1` Bring CLI `--help` output into parity with `parseArgs()` and add help contract tests — `src/cli/help.ts`, `src/cli/args.ts`, `test/cli/*` — many supported flags still do not appear in help output.
- [ ] 117. `P1` Add headless protocol and attachment contract tests — `src/cli/headless.ts`, `test/cli/*` or `test/integration/*` — prompt/interrupt/approval/session-info and attachment branches need direct coverage.
- [ ] 118. `P1` Add RPC-mode protocol tests — `src/cli/rpc-mode.ts`, `test/cli/*` or `test/integration/*` — the stdio JSON surface still lacks a dedicated test matrix.

## 4. Direct TODO/FIXME/skip follow-up backlog

- [ ] 119. `P1` Implement checkpoint deletion instead of showing “not yet implemented” — `src/cli-tui/commands/undo-handlers.ts`, related tracker/state files — the user-visible command currently dead-ends.
- [ ] 120. `P1` Implement prompt and agent hook execution types or remove the dead branches — `src/hooks/executor.ts`, hook config/tests — the executor currently logs these hook types as not implemented.
- [ ] 121. `P2` Add regression tests for git-view TODO/FIXME detection previews — `src/cli-tui/git/git-view.ts`, `test/tui/*` — TODO parsing drives toast UX but is not directly covered.
- [ ] 122. `P2` Turn Redis rate-limiter integration from `skipIf` into a documented local/CI harness — `test/web/redis-rate-limiter.test.ts`, `docker-compose.yml`, test setup scripts — skipped integration paths need a deterministic path to run.
- [ ] 123. `P2` Turn docker sandbox integration from permanent skips into an opt-in harness — `test/slack-agent/sandbox.test.ts`, sandbox setup scripts — the deepest sandbox behavior is still only manual.
- [ ] 124. `P2` Reduce `find` test skip inventory by making tool-environment capability explicit — `test/tools/find.test.ts`, `src/tools/find.ts`, CI setup — too many `skipIf(!hasFd)` branches hide behavior regressions.
- [ ] 125. `P2` Decide how to exercise Sharp-enabled image processing in CI or split the tests by capability — `test/tools/image-processor.test.ts`, optional dependency config — the current skip pattern hides real image-processing behavior.
- [ ] 126. `P2` Audit and shrink the repo-wide `describe.skip` / `it.skip` inventory — `test/build/package-builds.test.ts`, `test/db/db-integration.test.ts`, `test/utils/fs.test.ts`, and other skipped suites — too much behavior is still unexecuted by default.
- [ ] 127. `P2` Convert “future API / not yet implemented” user-facing copy into tracked feature flags or real implementations — `docs/ENTERPRISE.md`, `src/hooks/executor.ts`, `src/cli-tui/commands/undo-handlers.ts` — dead promises should become explicit work items, not quiet stubs.

## Immediate execution wave

- [x] Harden eval verification so the backlog itself is harder to regress.
- [x] Tighten live smoke sentinel matching.
- [x] Add first-class package scripts for the new live/judge eval entrypoints.
- [ ] Pick the next auth/parity batch after those infra tasks land.
