# Changelog

All notable changes to this project will be documented here. The format loosely
follows [Keep a Changelog](https://keepachangelog.com/) and adheres to semantic
versioning when releases are cut.

## Unreleased

### Added

- Catalog every current interactive OpenRouter model from OpenRouter's public
  `/api/v1/models` list in `maestro models`, the TUI selector, and the
  runtime-gateway registry. Selections use `openrouter/<vendor>/<model>` and
  stay on Chat Completions.
- Refresh the OpenRouter catalog automatically: hourly runtime cache
  updates that survive a single-source outage, selector reload from that
  cache, runtime-gateway live hydration when no gateway catalog is set, and a
  daily workflow that opens `chore/model-catalog-refresh` when the bundled
  snapshot drifts.
- `/rubber-duck [model]` (alias `/duck`) in the native Rust TUI: reviews the
  current uncommitted changes (`git diff HEAD`) with a different model than
  the active session — a second-opinion review that runs in the background
  with read-only tools and posts the result into the chat.
- Web server boot probe for `maestro-tui`: error when the binary is missing for
  native web/headless defaults (`src/server/maestro-tui-boot-check.ts`).
  Force TypeScript with `MAESTRO_TS_AGENT=1` to skip the probe.
- One-line installer (`scripts/install.sh`) downloads and installs
  `maestro-tui-<platform>` next to `maestro` so interactive TUI and default web
  chat work without a separate step.
- Added a weekly internal patch-release cadence that opens or refreshes release
  PRs with generated changelog entries from commits since the latest semver tag.
- Added first-class support for the major Chinese model providers — DeepSeek,
  Moonshot/Kimi, Alibaba Qwen (DashScope), MiniMax, and Z.ai/Zhipu GLM — across
  the model registry, API-key resolution, `/config` presets, and the native Rust
  TUI, including DeepSeek's previously missing `DEEPSEEK_API_KEY` lookup.

### Changed

- Document install paths for `maestro-tui` / `MAESTRO_TUI_BIN` (README, Web UI,
  Quickstart, Architecture, TUI Architecture) now that web defaults to native
  headless.
- Release version bumps now include the generated changelog entry in the PR body
  and keep scheduled public runs inert so public publishing stays downstream of
  the internal source-of-truth release.

## [0.10.71-beta.22] - 2026-08-27

### Changed

- Maintenance release with repository, CI, or documentation updates since the previous tag.

## [0.10.70] - 2026-08-19

### Added

- Bind Platform controller context on headless hello (#3497). <!-- maestro-release-note:18ad432b83ed -->

### Changed

- Retrigger rust-tests after SIGKILL on #3499. <!-- maestro-release-note:056e5b7c576c -->
- Refresh bundled model catalog (#3491). <!-- maestro-release-note:1e39c77cf3c1 -->

### Fixed

- Keep tag-release contract green on the public tree (#3504). <!-- maestro-release-note:1c1391898342 -->
- Run the protocol lock on hosted linux-medium (#3503). <!-- maestro-release-note:60e6f1f2fc88 -->
- Cap rustc codegen units to stop SIGKILL on maestro-tui (#3502). <!-- maestro-release-note:31a8b8a41ec5 -->
- Fail protocol lock before rust-tests and cap compile jobs (#3501). <!-- maestro-release-note:a58c546eee6f -->
- Refresh controller-binding compatibility manifest (#3499). <!-- maestro-release-note:3552d6f287fe -->
- Live-session bugs in /cost, connections, and doctor (#3500). <!-- maestro-release-note:c52c8e5951d4 -->
- Repair slash-command setup and developer flows (#3498). <!-- maestro-release-note:dfabbc0515dc -->
- Stop creating broken advisory jobs on push (#3496). <!-- maestro-release-note:0d3d7007b90b -->
- Keep protocol rejection when ledger cleanup fails. <!-- maestro-release-note:b7209bdaa3a3 -->
- Run nightly coverage with nextest so it can finish (#3494). <!-- maestro-release-note:c921a776eebe -->
- Stop advisory coverage from holding merge builds open (#3493). <!-- maestro-release-note:f1e0f5fffb4e -->
- Bump h2 to 0.4.16 for RUSTSEC-2026-0258 (#3492). <!-- maestro-release-note:801f4fa30a51 -->
- Reap dead background-task leftovers on launch (#3488). <!-- maestro-release-note:acdf943c0b24 -->
- Clear Clippy -D warnings and cap small-context output budgets (#3490). <!-- maestro-release-note:ebc31bfe6de2 -->

## [0.10.69] - 2026-08-17

### Added

- Add TUI `/setup` modal and open it on first launch when no credentials exist (#3485). <!-- maestro-release-note:6ad3f9cf7c46 -->

## [0.10.68] - 2026-08-17

### Added

- Require Platform identity or local BYOK (#3475). <!-- maestro-release-note:c51bf6266981 -->
- Add secure portable session transfer (#3470). <!-- maestro-release-note:de96c85fccc1 -->
- Add signed stable and preview release channels (#3467). <!-- maestro-release-note:762e8a3684e3 -->
- Add alpha and beta update channels (#3468). <!-- maestro-release-note:c7df8d56fec5 -->
- Add evaluation-backed shadow routing (#3464). <!-- maestro-release-note:c4a12d164ac9 -->
- Make runtime automations durable (#3465). <!-- maestro-release-note:c5cc93b211fd -->

### Changed

- Refresh models.dev and OpenRouter snapshot (#3480). <!-- maestro-release-note:a4a1c90582ac -->
- Drive EvalOps PKCE login against a local identity stub (#3478). <!-- maestro-release-note:440d7a2fa537 -->
- Bind fixture to rotated key. <!-- maestro-release-note:663e5f7e0c42 -->
- Guard public-only mirror workflow checks (#3463). <!-- maestro-release-note:cc9ef74102a1 -->
- Isolate supply-chain temporary files. <!-- maestro-release-note:38efa0eeaf7f -->
- Route Buildkite jobs to provisioned images. <!-- maestro-release-note:9c7ef3a85cc5 -->
- Bound and retry stuck JetBrains workers. <!-- maestro-release-note:e27f9a60c164 -->
- Scope mirror workflow test to its owner. <!-- maestro-release-note:64da324f9b7f -->

### Fixed

- Keep OpenRouter BYOK local and honor config.json maxTokens (#3483). <!-- maestro-release-note:b513482dc059 -->
- Honor ~/.maestro model settings and cap max_tokens (#3479). <!-- maestro-release-note:2b5fada5617a -->
- Import CheckStatus used by setup readiness (#3477). <!-- maestro-release-note:739208ce6881 -->
- Keep composer cursor off the placeholder (#3474). <!-- maestro-release-note:e0b6f1ce5f52 -->
- Keep setup ready unless credential_mode failed (#3476). <!-- maestro-release-note:6f5e51701c76 -->
- Skip missing files during preview channel version bump (#3473). <!-- maestro-release-note:d3a374d6a2b9 -->
- Resolve preview installs from signed channel pointers (#3472). <!-- maestro-release-note:ce3638ff3b1b -->
- Correct empty update-channel assignment (#3471). <!-- maestro-release-note:d6822228ccf5 -->
- Let JetBrains validation exit cleanly. <!-- maestro-release-note:eab5854e41c4 -->
- Satisfy installer shellcheck. <!-- maestro-release-note:7bb56ee5aca5 -->
- Rotate shared channel signing keys. <!-- maestro-release-note:2b646c7ffb53 -->
- Use bounded https sources for arm64 release tools (#3466). <!-- maestro-release-note:2987b8cfbce4 -->

## [0.10.67] - 2026-08-17

### Added

- Require Platform identity or local BYOK (#3475). <!-- maestro-release-note:c51bf6266981 -->
- Add secure portable session transfer (#3470). <!-- maestro-release-note:de96c85fccc1 -->
- Add signed stable and preview release channels (#3467). <!-- maestro-release-note:762e8a3684e3 -->
- Add alpha and beta update channels (#3468). <!-- maestro-release-note:c7df8d56fec5 -->
- Add evaluation-backed shadow routing (#3464). <!-- maestro-release-note:c4a12d164ac9 -->
- Make runtime automations durable (#3465). <!-- maestro-release-note:c5cc93b211fd -->

### Changed

- Refresh models.dev and OpenRouter snapshot (#3480). <!-- maestro-release-note:a4a1c90582ac -->
- Drive EvalOps PKCE login against a local identity stub (#3478). <!-- maestro-release-note:440d7a2fa537 -->
- Bind fixture to rotated key. <!-- maestro-release-note:663e5f7e0c42 -->
- Guard public-only mirror workflow checks (#3463). <!-- maestro-release-note:cc9ef74102a1 -->
- Isolate supply-chain temporary files. <!-- maestro-release-note:38efa0eeaf7f -->
- Route Buildkite jobs to provisioned images. <!-- maestro-release-note:9c7ef3a85cc5 -->
- Bound and retry stuck JetBrains workers. <!-- maestro-release-note:e27f9a60c164 -->
- Scope mirror workflow test to its owner. <!-- maestro-release-note:64da324f9b7f -->

### Fixed

- Store only distinct output token limits. <!-- maestro-release-note:4572e6043520 -->
- Honor ~/.maestro model settings and cap max_tokens (#3479). <!-- maestro-release-note:2b5fada5617a -->
- Import CheckStatus used by setup readiness (#3477). <!-- maestro-release-note:739208ce6881 -->
- Keep composer cursor off the placeholder (#3474). <!-- maestro-release-note:e0b6f1ce5f52 -->
- Keep setup ready unless credential_mode failed (#3476). <!-- maestro-release-note:6f5e51701c76 -->
- Skip missing files during preview channel version bump (#3473). <!-- maestro-release-note:d3a374d6a2b9 -->
- Resolve preview installs from signed channel pointers (#3472). <!-- maestro-release-note:ce3638ff3b1b -->
- Correct empty update-channel assignment (#3471). <!-- maestro-release-note:d6822228ccf5 -->
- Let JetBrains validation exit cleanly. <!-- maestro-release-note:eab5854e41c4 -->
- Satisfy installer shellcheck. <!-- maestro-release-note:7bb56ee5aca5 -->
- Rotate shared channel signing keys. <!-- maestro-release-note:2b646c7ffb53 -->
- Use bounded https sources for arm64 release tools (#3466). <!-- maestro-release-note:2987b8cfbce4 -->

## [0.10.66] - 2026-08-17

### Added

- Add native startup auto-update (#3455). <!-- maestro-release-note:df79db8e37db -->
- Add Maestro connections dashboard (#3452). <!-- maestro-release-note:8bde3b51277a -->
- Execute shell only through Platform ToolExecution (#3450). <!-- maestro-release-note:250b0a5375bd -->
- Catalog current OpenRouter models and auto-refresh (#3447). <!-- maestro-release-note:f7db1167a332 -->
- Add native Kimi K3 support (#3445). <!-- maestro-release-note:96cdaffed81e -->
- Add managed connections and scoped grants (#3442). <!-- maestro-release-note:f9d609a4b2b9 -->
- Auto-detect and optimize local model runtimes (#3440). <!-- maestro-release-note:271b6c37c71c -->
- Bind runtime passports to exact artifacts. <!-- maestro-release-note:0b1fd53a7215 -->
- Publish generation-bound lifecycle receipts (#3425). <!-- maestro-release-note:38e8479edf62 -->
- Add executable hosted launch spec. <!-- maestro-release-note:dd2bbf77781d -->
- Publish typed headless protocol semantics (#3423). <!-- maestro-release-note:7e9227fb85f9 -->
- Add hosted runtime boundary. <!-- maestro-release-note:1f75aca7827f -->

### Changed

- Refresh bundled model catalog (#3460). <!-- maestro-release-note:6ab1259145a5 -->
- [maestro] Add durable update lifecycle (#3459). <!-- maestro-release-note:f3ae79d172d4 -->
- Isolate JetBrains worker concurrency. <!-- maestro-release-note:d6a3cc7e08b1 -->
- Route JetBrains validation to heavy workers. <!-- maestro-release-note:9ed4c2fc8bb9 -->
- Keep existing policy findings blocking. <!-- maestro-release-note:5350d2241138 -->
- Make tooling lane image-independent. <!-- maestro-release-note:c68eabe9a325 -->
- Honor activation inputs in policy scans. <!-- maestro-release-note:787d68353c04 -->
- Isolate Maestro worker concurrency. <!-- maestro-release-note:e7a55c8ece02 -->
- Close supply-chain activation gaps. <!-- maestro-release-note:ca2f215aeede -->
- Bind policy approval to PR timeline. <!-- maestro-release-note:f226e1c0bb02 -->
- Route Maestro to current heavy image. <!-- maestro-release-note:27a67b6af611 -->
- Prioritize current Buildkite validation. <!-- maestro-release-note:2cf58515561f -->

### Fixed

- Include installer in native image build (#3457). <!-- maestro-release-note:a8529580546d -->
- Preserve governed execution replay safety (#3454). <!-- maestro-release-note:15f18d1d3bc4 -->
- Tighten managed connection authority (#3444). <!-- maestro-release-note:1f39f3940a12 -->
- Discover local limits in headless mode (#3446). <!-- maestro-release-note:e30b0b0d5177 -->
- Address public mirror review feedback (#3443). <!-- maestro-release-note:f16d6c1df70c -->
- Use the available heavy self-hosted pool. <!-- maestro-release-note:eb7ee3e635c6 -->
- Skip viewport clears on fallback terminals. <!-- maestro-release-note:c5b047d5a660 -->
- Run serial session tests before Nextest. <!-- maestro-release-note:923f11965f5a -->
- Respect protected self-hosted homes. <!-- maestro-release-note:d2175aa67541 -->
- Serialize the Maestro session cohort. <!-- maestro-release-note:ba09efa2d58f -->
- Run shared session tests under serial libtest. <!-- maestro-release-note:56c48e4e8b8f -->
- Isolate restored session scope test. <!-- maestro-release-note:40beed0efa16 -->

## [0.10.65] - 2026-08-06

### Added

- Wire rendezvous runtime (#3334). <!-- maestro-release-note:eaf592722c8d -->
- Improve session recovery and turn feedback (#3337). <!-- maestro-release-note:81ea8c3151aa -->
- Wire outbound rendezvous runtime (#3335). <!-- maestro-release-note:26d2d91ee06d -->
- Add persistent agent context surfaces (#3333). <!-- maestro-release-note:810fdb2577ff -->
- Add outbound rendezvous carrier. <!-- maestro-release-note:1c7ef96d5530 -->
- Define outbound rendezvous protocol (#3330). <!-- maestro-release-note:2a4c6019ea4b -->
- Bring Grok-class session controls to Maestro (#3329). <!-- maestro-release-note:867d85014ffd -->
- Add durable continual harness context (#3326). <!-- maestro-release-note:2018cc17b40b -->

### Changed

- Parallelize initial identity exchanges (#3338). <!-- maestro-release-note:3357831c49cc -->
- Preserve hosted-runner drain after child exit (#3328). <!-- maestro-release-note:8f8e89cc16b1 -->
- Clear Rust and devcontainer backlog (#3324). <!-- maestro-release-note:8b0ae8ad918f -->

### Fixed

- Enable UUID serde for macOS release targets (#3336). <!-- maestro-release-note:b203b2869954 -->
- Deflake shutdown_reaps_registered_background_bash fixture (#3327). <!-- maestro-release-note:e17376585f69 -->
- Revoke readiness when agent exits (#3325). <!-- maestro-release-note:1be225442b0c -->
- Validate managed model before ready (#3323). <!-- maestro-release-note:d36bbd202836 -->
- Wait 45s for initial identity exchange (#3322). <!-- maestro-release-note:4c4ebbea4713 -->

## [0.10.64] - 2026-08-05

### Added

- Define outbound rendezvous protocol (#3330). <!-- maestro-release-note:2a4c6019ea4b -->
- Bring Grok-class session controls to Maestro (#3329). <!-- maestro-release-note:867d85014ffd -->
- Add durable continual harness context (#3326). <!-- maestro-release-note:2018cc17b40b -->

### Changed

- Preserve hosted-runner drain after child exit (#3328). <!-- maestro-release-note:8f8e89cc16b1 -->
- Clear Rust and devcontainer backlog (#3324). <!-- maestro-release-note:8b0ae8ad918f -->

### Fixed

- Deflake shutdown_reaps_registered_background_bash fixture (#3327). <!-- maestro-release-note:e17376585f69 -->
- Revoke readiness when agent exits (#3325). <!-- maestro-release-note:1be225442b0c -->
- Validate managed model before ready (#3323). <!-- maestro-release-note:d36bbd202836 -->
- Wait 45s for initial identity exchange (#3322). <!-- maestro-release-note:4c4ebbea4713 -->

## [0.10.63] - 2026-08-05

### Added

- Add native Bedrock Converse streaming (#3316). <!-- maestro-release-note:f4aeff49e521 -->
- Harden subagent ops after #3282 (#3306). <!-- maestro-release-note:7c3f737bd63a -->
- Add governed subagent operations (#3282). <!-- maestro-release-note:8a2e03f9d12c -->
- Expose startup lifecycle evidence (#3303). <!-- maestro-release-note:0ec56139987b -->

### Changed

- Create replay gate output parent (#3313). <!-- maestro-release-note:ca8cf4d726df -->
- Parallelize scenario replay and add tracing. <!-- maestro-release-note:9de19764c992 -->
- Fix hosted runner identity binding (#3310). <!-- maestro-release-note:c62cbe9d55ec -->
- Make journal-write failure semantics explicit (#3307). <!-- maestro-release-note:2281aa94572b -->

### Fixed

- Resolve EvalOps gateway token from ACCESS_TOKEN_FILE (#3320). <!-- maestro-release-note:50de7ad45cd2 -->
- Make fatal runtime state terminal (#3319). <!-- maestro-release-note:38d70671d1be -->
- Honor canonical placement generation (#3318). <!-- maestro-release-note:97668edd5bc6 -->
- Preserve provider on model selection (#3317). <!-- maestro-release-note:f594e345f2e2 -->
- Guard the boundary lists and shipped-script references (#3308). <!-- maestro-release-note:3c47e9801843 -->
- Route explicit Vertex AI models (#3315). <!-- maestro-release-note:24bd9bd442dc -->
- Catalog Vertex Gemini routes (#3314). <!-- maestro-release-note:46e282fcedca -->
- Run workspace clippy from check-pr.sh even when crate-scoped (#3309). <!-- maestro-release-note:a3f0632ee255 -->
- Treat a dropped response receipt as a rejection (#3305). <!-- maestro-release-note:5a9d80d5cca2 -->
- Canonicalize the stored login providerRef tuple (#3304). <!-- maestro-release-note:61073de5bcb9 -->
- Close hosted response lifecycle races (#3296). <!-- maestro-release-note:ed73aa4b93f5 -->
- Stop shipping the drift checker to the public tree (#3301). <!-- maestro-release-note:c240568988cc -->

## [0.10.62] - 2026-08-03

### Added

- Instrument hosted runner requests (#3285). <!-- maestro-release-note:e97f310dbbe2 -->
- Add durable subagent lifecycle tools (#3274). <!-- maestro-release-note:c2b7886f0720 -->
- Version response acceptance event. <!-- maestro-release-note:0446a4977094 -->
- Unify Maestro product surface and install safety (#3263). <!-- maestro-release-note:3f3068bf68bd -->
- Scripted-replay provider + scenario run --execute (#3257) (#3259). <!-- maestro-release-note:028acc26410b -->
- Add durable hosted threads (#3252). <!-- maestro-release-note:1604f73a2a69 -->
- Rotate workload mTLS identity (#3249). <!-- maestro-release-note:04c62f6583a5 -->
- Support arbitrary OpenRouter model routes (#3291). <!-- maestro-release-note:bfa7a9e16002 -->

### Changed

- Accelerate the agent tool loop (#3278). <!-- maestro-release-note:666a3d5b98f1 -->
- Add a skill for verifying the Maestro headless protocol locally (#3280). <!-- maestro-release-note:e09cd5dabc9c -->
- Cache dynamic goal tool visibility (#3276). <!-- maestro-release-note:1028c23f8347 -->
- Route workloads to Hetzner private lanes (#3277). <!-- maestro-release-note:3bc2c5dfbc35 -->
- Reduce loop allocations and baseline agent workloads (#3275). <!-- maestro-release-note:7c1a3f767243 -->
- Serialize concurrent response retries. <!-- maestro-release-note:356052f40153 -->
- Cache terminal dimensions between resizes (#3271). <!-- maestro-release-note:9cb9bb76ad4c -->
- Bound search and redraw allocations. <!-- maestro-release-note:822fd1d30d26 -->
- Cache message layout signatures. <!-- maestro-release-note:fcfe259f7407 -->
- Bound file search ranking work. <!-- maestro-release-note:2c421b926fe4 -->
- Kill the whole prefetch process group in the watchdog fallback (#3294). <!-- maestro-release-note:cafbe1e223bc -->
- Use test-world fixtures in ambient-agent (#3281). <!-- maestro-release-note:7efb15eb68e7 -->

### Fixed

- Retry identity bootstrap. <!-- maestro-release-note:55259f970965 -->
- Preserve hosted model binding (#3286). <!-- maestro-release-note:fc4d1957c2bb -->
- Allow multiple hosted Maestro origins (#3283). <!-- maestro-release-note:e0e41651aa5f -->
- Negotiate the client protocol version on Hello (#3279). <!-- maestro-release-note:1ef42aa41373 -->
- Key retries by request identity. <!-- maestro-release-note:ea9da65e44e3 -->
- Close response protocol and ledger gaps. <!-- maestro-release-note:eb853961b6fc -->
- Use portable atomic ledger writes. <!-- maestro-release-note:7d7676cc18fa -->
- Correlate response acknowledgements. <!-- maestro-release-note:a660f9dac48e -->
- Preserve response acceptance receipts. <!-- maestro-release-note:1dd85fbbc395 -->
- Require response consumption acknowledgements. <!-- maestro-release-note:b89d44df375f -->
- Model executor response inbox states. <!-- maestro-release-note:ba3dab28e3b9 -->
- Persist production response acceptance. <!-- maestro-release-note:d8dd0e50e2d8 -->

## [0.10.61] - 2026-07-31

### Added

- Query cerebro memory first in incident-triage (#3246). <!-- maestro-release-note:20efff4066f6 -->
- Inject background-task lifecycle into agent as tool notes (#3247). <!-- maestro-release-note:a64562eaa5b4 -->

### Fixed

- Goal resume-as-paused and non-blocking background tasks (#3244). <!-- maestro-release-note:b88e9d00a176 -->

## [0.10.60] - 2026-07-31

### Added

- Persist autonomous mission threads. <!-- maestro-release-note:111122b9fe8d -->
- Attach remove + marketplace install provenance (#3237). <!-- maestro-release-note:566313c46fdb -->

### Fixed

- Billable goal tokens and smaller default tool payload (#3242). <!-- maestro-release-note:b6543669a113 -->
- Goal complete clobber + bugbash status/slash/prompt (#3241). <!-- maestro-release-note:1bc0ae82cb83 -->
- Do not burn goal auto-continue without an agent (#3239). <!-- maestro-release-note:d0e581889607 -->

## [0.10.59] - 2026-07-30

### Added

- Codex-style goal completion (update_goal, no second model) (#3233). <!-- maestro-release-note:4ba093d4d69b -->
- Goal completion judged by second model (#3232). <!-- maestro-release-note:53e55554821a -->
- Harden goal, attach, footer prefs, marketplace installed (#3231). <!-- maestro-release-note:3991a4564d7d -->
- Kimi-inspired goal, footer, attach, marketplace (#3228). <!-- maestro-release-note:770647446c23 -->

### Fixed

- Codex app-server assistant text and instructions polish (#3229). <!-- maestro-release-note:6152e46959cd -->

## [0.10.58] - 2026-07-30

### Added

- Native openai-codex via app-server; fix Landlock stage-2 nest. <!-- maestro-release-note:f3efe0db153a -->
- Landlock stage-2 + Codex app-server turn client. <!-- maestro-release-note:2333a34440f4 -->

### Fixed

- Address #3225 review — Landlock stage-1 + app-server gaps. <!-- maestro-release-note:fd4c98074eb6 -->
- Enforce Landlock stage-2 write carve-out with FullyEnforced domain. <!-- maestro-release-note:4ce3897e93c6 -->
- Use canonicalize_best_effort in Landlock stage-2 tests. <!-- maestro-release-note:6228dd5fc02c -->

## [0.10.57] - 2026-07-30

### Added

- Codex 401 refresh, doctor login check, install helper (#3220). <!-- maestro-release-note:eea54a44d3bd -->

### Fixed

- Auto-wire Codex ChatGPT auth for native agent startup (#3219). <!-- maestro-release-note:4aa06caddc9a -->

## [0.10.56] - 2026-07-27

### Added

- Adopt defensive LLM goal evaluator for completion claims (#3087). <!-- maestro-release-note:a144d8b312b5 -->
- Version bash tool behavior for session replay (#3089). <!-- maestro-release-note:7cc01d97a68b -->
- Add Droid-style executable slash commands from .composer/commands (#3080). <!-- maestro-release-note:df504fac2948 -->
- Add Droid-style -w/--worktree session worktrees (#3079). <!-- maestro-release-note:13dcfc57d1ec -->
- Coalesce parallel tool-call approvals into one modal (#3081). <!-- maestro-release-note:f426147d2562 -->
- Add /context token breakdown command (#3077). <!-- maestro-release-note:499607d62ef7 -->
- Add @maestro PR-comment agent workflow (review/fill/security) (#3082). <!-- maestro-release-note:1a0a294a90f5 -->
- Add maestro search full-text session search (#3078). <!-- maestro-release-note:e059e24103a0 -->
- Ctrl+E full-output detail view for transcript and approval modal (#3084). <!-- maestro-release-note:fb1d9b112afd -->
- Model selector focused slice, catalog metadata, set-as-default (#3083). <!-- maestro-release-note:5b2c4508156f -->
- Live model catalog from models.dev with runtime overlay (#3075). <!-- maestro-release-note:be941ada1512 -->
- Paste folding with unit-delete (#3065). <!-- maestro-release-note:116124075b52 -->
- Deixic diagonal shimmer and welcome brand mark (#3216). <!-- maestro-release-note:dc9153fc5f33 -->
- Trust UX, status badges, sandbox command, CLI cleanup (#3214). <!-- maestro-release-note:887ba7ee26f0 -->
- Sandbox the interactive TUI by default (stage 1, internal gate) (#3144). <!-- maestro-release-note:7879da94290c -->
- Wrap untrusted tool output in a provenance envelope (#3136). <!-- maestro-release-note:179015ab74ac -->
- Guardian auto-adjudication of approval prompts (#3128). <!-- maestro-release-note:ebb9ba329661 -->
- Session index, maestro fork, fast session switcher (#3129). <!-- maestro-release-note:df400136140e -->
- Pre-main process hardening (core dumps, ptrace, loader vars) (#3127). <!-- maestro-release-note:8fbb30f150bb -->
- Add native interoperability and extension workflows (#3187). <!-- maestro-release-note:ccc911586932 -->
- Improve terminal input and frame rendering (#3182). <!-- maestro-release-note:d3a9bb7678f2 -->
- Add advisory perf-baseline regression gate (#3093). <!-- maestro-release-note:e61920199dcf -->
- Adopt grok-build crash handler for SIGSEGV/SIGBUS (#3094). <!-- maestro-release-note:f0088c876c76 -->
- Pin replay executor to recorded bash tool version (#3098). <!-- maestro-release-note:e58d82b556bb -->

### Changed

- Add cargo-deny supply-chain scanning (advisories/licenses/bans/sources) (#3152). <!-- maestro-release-note:2d1013d39b02 -->
- Add advisory cargo-llvm-cov coverage visibility (#3157). <!-- maestro-release-note:c339aef5ea27 -->
- Extract AI provider client layer into maestro-ai crate (#3148). <!-- maestro-release-note:452afb3b9cce -->
- Enable shellcheck inside actionlint and add a zizmor gate (#3130). <!-- maestro-release-note:0cbc43a8a8c8 -->
- Close fail-open gaps in required-checks invariant, wire workflow footguns (#3103). <!-- maestro-release-note:2aed68aaeb4d -->
- Drop unreachable pull_request runner ternaries from mirror workflows (#3132). <!-- maestro-release-note:24950042812c -->
- Collapse the evals fan-out from three jobs to one (#3137). <!-- maestro-release-note:3df1f0366633 -->
- Stop main-push ci runs from cancelling each other (#3120). <!-- maestro-release-note:9018334d85f4 -->
- Remove duplicate Rust runtime lane (#3102). <!-- maestro-release-note:ba49600e8d74 -->
- Stop per-run CARGO_HOME from voiding every Rust cache (#3135). <!-- maestro-release-note:6fcf2b962433 -->
- Move trivial PR gates to ARC and put release runners behind vars (#3131). <!-- maestro-release-note:95dd31f7d83c -->
- Bump org workflow pins and put Codex Rails and the review guard on ARC (#3168). <!-- maestro-release-note:a8bb5eaf14b4 -->
- Deflake MarkItDown pid-file readiness waits in extract_document tests (#3217). <!-- maestro-release-note:312e532ba0b6 -->
- Deflake background shell argv test by waiting for file contents (#3215). <!-- maestro-release-note:1f6f994a229f -->
- Deflake six test issues (APFS filename, flock inheritance, pid-file races, rewind) (#3213). <!-- maestro-release-note:fe4c6cf89c5f -->
- Structurally validate required setup-node step (#3208). <!-- maestro-release-note:dadeeab9b8c1 -->
- Accept approved setup-node required-gate pins (#3205). <!-- maestro-release-note:c7eef9f3d17b -->
- Require PyYAML 6.0.3 (#3206). <!-- maestro-release-note:68b015d8ebe8 -->
- [maestro] add /rubber-duck second-opinion review with a different model (#3199). <!-- maestro-release-note:647b5e3f91ce -->
- PTY e2e harness driving the real binary against a mock model (#3092). <!-- maestro-release-note:a881fd959866 -->
- Collapse duplicated CLI dispatch surface into one routing path (#3116). <!-- maestro-release-note:66480f08daea -->
- Prune orphaned scripts, fix stale runners and doc drift (#3105). <!-- maestro-release-note:ed4b3c5bbbb8 -->
- Run auto-update regression in required gate. <!-- maestro-release-note:023dcff1aeb0 -->
- Preserve crate seam snapshot provenance. <!-- maestro-release-note:f46c86c469fd -->

### Fixed

- Gate @maestro on write access and stop leaving credentials on runners (#3119). <!-- maestro-release-note:534148726139 -->
- Nested pattern alternatives; fix(tui): batched approvals reachable (#3096). <!-- maestro-release-note:ac39403a61e3 -->
- Bump pdf-extract past vulnerable lopdf, add advisory CI gate (#3140). <!-- maestro-release-note:fe29eb425b9a -->
- Normalize hook-modified tool args. <!-- maestro-release-note:b7e4a84ea537 -->
- Preserve native tool completion details. <!-- maestro-release-note:f0282533bb8d -->
- Record native tool completions. <!-- maestro-release-note:2e0cbfea6523 -->
- Normalize empty bash before native execution. <!-- maestro-release-note:511e84b5cf8c -->
- Make the native agent the sole owner of tool approve/execute. <!-- maestro-release-note:16556faccb08 -->
- Full provider error messages, /alerts command, stale-frame cleanup (#3076). <!-- maestro-release-note:878b392a390f -->
- Bound network clients, harden session persistence and ambient agent (#3072). <!-- maestro-release-note:602c32d67135 -->
- Repair orphaned tool calls in history after cancelled turns (#3074). <!-- maestro-release-note:de1a3d3c3aef -->
- Close security holes in bash auto-approval, MCP trust, and shell env (#3070). <!-- maestro-release-note:50f19918901c -->
- Use printf with newline in Landlock write test (#3212). <!-- maestro-release-note:f43c10841abe -->
- Fast-path public sync and honest Landlock stage-1 tests (#3211). <!-- maestro-release-note:01ace8eaf0b5 -->
- Disable external git diff helpers in rubber-duck (#3210). <!-- maestro-release-note:c791e18fe83a -->
- Adopt fsync atomic writes for checkpoints, ui-state, headless run records (#3153). <!-- maestro-release-note:15da4eed396a -->
- Fail closed when detecting remote branch (#3207). <!-- maestro-release-note:2ab879839a6e -->
- Install clippy for version validation (#3204). <!-- maestro-release-note:4751cce2880a -->
- Allow idempotent version refresh (#3203). <!-- maestro-release-note:1fd42da28373 -->
- Surface swallowed persistence/IO failures in agent hot paths (#3141). <!-- maestro-release-note:a3178b2e1046 -->
- Monitor fork shutdown lifecycle (#3202). <!-- maestro-release-note:78366ccb611b -->
- Retain public RBE runner label (#3200). <!-- maestro-release-note:97ddf050f267 -->
- Thread per-turn cancellation into the default tool path (#3163). <!-- maestro-release-note:45add4a95756 -->
- Preserve controller client tool arguments (#3198). <!-- maestro-release-note:35ed084f491c -->

## [0.10.55] - 2026-07-23

### Added

- Complete Rust-only runtime migration (#3016). <!-- maestro-release-note:7a2d69f58819 -->
- Harden headless tool event parity (#3006). <!-- maestro-release-note:4d692d4ab26c -->

### Changed

- Accelerate file search and transcript rendering (#3020). <!-- maestro-release-note:7951416f1c37 -->
- Unify and optimize the Rust workspace (#3018). <!-- maestro-release-note:5c49c829a451 -->
- Remove remaining TypeScript surfaces (#3017). <!-- maestro-release-note:8cf2ee6527fb -->
- Parallelize release readiness in CI (#3015). <!-- maestro-release-note:1234b116b3f1 -->
- [maestro] refactor(server): make product agent runtime native-only (#3014). <!-- maestro-release-note:2b381b40f412 -->
- [maestro] feat(server): native memory extraction/consolidation via maestro-tui (#3011). <!-- maestro-release-note:5f23daef9406 -->
- [maestro] feat(server): native chat history via headless protocol (#3008). <!-- maestro-release-note:e6971ffa467c -->
- [maestro] feat(tui-rs): headless conversation history seed (#3012). <!-- maestro-release-note:02d11c7e344e -->
- [maestro] chore(server): thin native-first handlers; isolate TS agent escape (#3013). <!-- maestro-release-note:060546512657 -->
- [maestro] feat(tui-rs): native maestro plugins list/info CLI (#3010). <!-- maestro-release-note:c06a1965adb6 -->
- [maestro] feat(server): auto-approve native headless tool calls for web (#3007). <!-- maestro-release-note:ac69d88a71b4 -->
- [maestro] chore: delete post-native server dead code (#3009). <!-- maestro-release-note:86500444c737 -->

### Fixed

- Preserve the versioned browser bundle in public mirror generation and restore
  secure, certificate-verified native container builds.
- Make release version bumps work without JavaScript workspaces and keep the
  Rust crate and lockfile versions aligned with the package version.
- Stop main-push CI cancel churn and restore self-hosted residuals (#3029). <!-- maestro-release-note:ac8108c6868f -->
- Grant mirror app pull request access (#3027). <!-- maestro-release-note:5912c3f3e724 -->
- Self-hosted residual CI after mirror workflow preserve (#3028). <!-- maestro-release-note:01d406753fc0 -->
- Preserve public-owned workflows in mirror (#3025). <!-- maestro-release-note:fc869b3c42d0 -->
- Prefer mirror token for workflow sync (#3024). <!-- maestro-release-note:33ae1c42f723 -->
- Restore post-merge publishing (#3023). <!-- maestro-release-note:c4c864746a30 -->
- Restore post-merge release CI (#3019). <!-- maestro-release-note:2174cf4aca97 -->
- Main health after native cutover (boot-check + /etc symlink) (#3003). <!-- maestro-release-note:cf78cd74414e -->
- Stop blocking first paint on home-directory rg scan (#2942). <!-- maestro-release-note:867f537e1161 -->
- Setup rust after build:all for binary smoke (#2941). <!-- maestro-release-note:c552d0ad2644 -->

## [0.10.54] - 2026-07-20

### Added

- Add Grok-inspired turn status row (#2933). <!-- maestro-release-note:d52b4f419d04 -->
- Move agents command to Rust (#2924). <!-- maestro-release-note:bf73aac1a8dd -->
- Adopt Grok-inspired session chrome (#2926). <!-- maestro-release-note:78870912899b -->
- Migrate modes command to Rust (#2921). <!-- maestro-release-note:0ba92aff6ac1 -->

### Changed

- Fix eval Guardian failure and unblock 0.10.53 (#2935). <!-- maestro-release-note:d85324f0c7ba -->
- Move OpenAI CLI authentication to Rust (#2934). <!-- maestro-release-note:81135348fd29 -->
- Move shared-memory CLI fully to Rust (#2932). <!-- maestro-release-note:bc9a4c8510a2 -->
- Migrate Anthropic CLI stub to Rust (#2930). <!-- maestro-release-note:ba98bd25cc03 -->
- Delete removed TypeScript exec runtime stub (#2931). <!-- maestro-release-note:55ce9b2dabb3 -->
- Move painter CLI fully to Rust (#2927). <!-- maestro-release-note:336a84ac9d85 -->
- Finish portable session transfer in Rust (#2929). <!-- maestro-release-note:1d7545b81aa8 -->
- Move skill CLI and package runtime to Rust (#2919). <!-- maestro-release-note:f3a840301d0a -->
- [maestro] Move update command to Rust and delete TypeScript handler (#2918). <!-- maestro-release-note:5f73114f3beb -->
- [maestro] Delete legacy TypeScript hosted runner command (#2917). <!-- maestro-release-note:d0c2ec8a540c -->
- [maestro] Delete migrated TypeScript utility commands (#2916). <!-- maestro-release-note:cf20e9e09c07 -->
- [maestro] Move hosted runner lifecycle to Rust (#2914). <!-- maestro-release-note:00b2db4e7c8b -->

### Fixed

- Package stripped Rust TUI binaries for every supported npm platform and build
  them on Blacksmith runners before publishing.
- Make packed and registry install smokes launch a native Rust command so a
  missing `vendor/maestro-tui` payload blocks publication.
- Hand off utilities before replay setup (#2925). <!-- maestro-release-note:d9552c52997f -->
- Align native utility global flags (#2923). <!-- maestro-release-note:0c5f04580384 -->
- Consume named worktree before native utilities (#2922). <!-- maestro-release-note:326239dc0057 -->
- Enforce native skill package validation (#2920). <!-- maestro-release-note:077875bf3882 -->
- Accept public runner failover variable (#2915). <!-- maestro-release-note:e94c6cadf8e5 -->

## [0.10.53] - 2026-07-20

### Added

- Move agents command to Rust (#2924). <!-- maestro-release-note:bf73aac1a8dd -->
- Adopt Grok-inspired session chrome (#2926). <!-- maestro-release-note:78870912899b -->
- Migrate modes command to Rust (#2921). <!-- maestro-release-note:0ba92aff6ac1 -->

### Changed

- Move skill CLI and package runtime to Rust (#2919). <!-- maestro-release-note:f3a840301d0a -->
- [maestro] Move update command to Rust and delete TypeScript handler (#2918). <!-- maestro-release-note:5f73114f3beb -->
- [maestro] Delete legacy TypeScript hosted runner command (#2917). <!-- maestro-release-note:d0c2ec8a540c -->
- [maestro] Delete migrated TypeScript utility commands (#2916). <!-- maestro-release-note:cf20e9e09c07 -->
- [maestro] Move hosted runner lifecycle to Rust (#2914). <!-- maestro-release-note:00b2db4e7c8b -->

### Fixed

- Hand off utilities before replay setup (#2925). <!-- maestro-release-note:d9552c52997f -->
- Align native utility global flags (#2923). <!-- maestro-release-note:0c5f04580384 -->
- Consume named worktree before native utilities (#2922). <!-- maestro-release-note:326239dc0057 -->
- Enforce native skill package validation (#2920). <!-- maestro-release-note:077875bf3882 -->
- Accept public runner failover variable (#2915). <!-- maestro-release-note:e94c6cadf8e5 -->

## [0.10.52] - 2026-07-20

### Breaking

- Removed the TypeScript Agent bootstrap from the CLI shim. Interactive, print/exec,
  and headless/rpc always run on native `maestro-tui`. `runHeadlessMode`,
  `runRpcMode`, and `runExecCommand` now throw with migration guidance.
- `MAESTRO_ALLOW_TS_AGENT` no longer re-enables a TS agent loop (the runtime is gone).

### Added

- Swap stats/models/agents-init to native; hard-cut TS agent bootstrap (#2901). <!-- maestro-release-note:c985b05b7b1c -->
- Kill remaining TS agent paths with native headless/print/CLI (#2900). <!-- maestro-release-note:c94ff552d417 -->
- Native print/exec path and CLI helpers off the TS agent. <!-- maestro-release-note:148056f5309b -->
- Route TTY prompts to native TUI; fill slash stubs (#2898). <!-- maestro-release-note:b309dce0567e -->
- Grok-style session UX, modes, and worktrees (#2897). <!-- maestro-release-note:9488fafea5c3 -->
- Grok-style trailing prompt and skills-as-slash (#2896). <!-- maestro-release-note:9d66d622b025 -->
- Ship maestro-tui binaries in npm packaging (#2888). <!-- maestro-release-note:3907ed2588bb -->
- Launch native maestro-tui for interactive mode (#2889). <!-- maestro-release-note:ed5b1e5dde9d -->
- Code-block-aware compaction + real BPE tokenizer (#2881). <!-- maestro-release-note:759b5121debd -->
- Centralize token estimation and add intra-turn compaction (#2879). <!-- maestro-release-note:c919ad1810dc -->
- Observe outcome-calibrated rollout (#2874). <!-- maestro-release-note:38b5b0a59224 -->
- Discover custom agents (#2873). <!-- maestro-release-note:d4ab2c5a6a83 -->

### Changed

- CI / mirror / release automation defaults to Blacksmith runners
  (`blacksmith-4vcpu-ubuntu-2404`, heavy: `blacksmith-8vcpu-ubuntu-2404`),
  overridable with `BLACKSMITH_RUNNER`, `BLACKSMITH_HEAVY_RUNNER`, or
  `INTERNAL_CONFIRMATION_RUNNER`.
- Document native maestro-tui as the only interactive UI (#2894). <!-- maestro-release-note:b432c992ef07 -->
- Add GitHub Actions pipelines TLS cert expiry canary (#2893). <!-- maestro-release-note:0aa55b439209 -->
- Harden native TUI launcher e2e and error messaging (#2892). <!-- maestro-release-note:0bee0ad0a7a1 -->
- [maestro] remove TypeScript TUI package and app tree (#2891). <!-- maestro-release-note:b7eb759e588d -->
- [maestro] detach non-TUI consumers from TypeScript TUI (#2890). <!-- maestro-release-note:07c8f3a5f492 -->
- Move static checks off private runners (#2885). <!-- maestro-release-note:6bdb4d559b2d -->
- Regenerate OpenAPI spec (#2878). <!-- maestro-release-note:7be41f13d070 -->
- Regenerate app server payload schemas (#2876). <!-- maestro-release-note:d6022fdbc067 -->
- Keep SSE resume session manager contract complete (#2875). <!-- maestro-release-note:4838427a09c7 -->
- [maestro] Add verified Oracle rollout API (#2867). <!-- maestro-release-note:6fc8ed4d7214 -->
- [maestro] Add agent operations replay panel (#2868). <!-- maestro-release-note:f4aafea1e72b -->
- Format watch notification test (#2871). <!-- maestro-release-note:58b26c20a306 -->

### Fixed

- Post-TS-TUI hygiene and Rust-first interactive guardrails (#2895). <!-- maestro-release-note:94a715a52bb5 -->
- Drop references to removed TypeScript TUI package (#2902). <!-- maestro-release-note:9674173f26e4 -->
- Resolve clippy -D warnings breaking main build (#2882). <!-- maestro-release-note:92d63fc605ba -->
- Pull Docker Hub base images via mirror.gcr.io (#2884). <!-- maestro-release-note:776488b247ea -->
- Persist painter binaries atomically (#2877). <!-- maestro-release-note:547c7659bede -->
- Recognize consultation prompt cues (#2863). <!-- maestro-release-note:2ba0d92d04a7 -->
- Preserve configured model resolution (#2861). <!-- maestro-release-note:a50c59a9ad07 -->
- Preserve sparse agent lineage metadata (#2859). <!-- maestro-release-note:f9b79dc87ab2 -->

## [0.10.51] - 2026-07-13

### Added

- Validate + deep-merge maestro settings on org write (#2832). <!-- maestro-release-note:3399f82e003f -->

### Changed

- Allow validated release commits (#2852). <!-- maestro-release-note:bc4d757ee52c -->
- Await resumed WebSocket completion (#2849). <!-- maestro-release-note:7d75f8c8f615 -->
- Preserve review audit compatibility. <!-- maestro-release-note:4da9fbacafd7 -->
- Tighten swarm validation review fixes. <!-- maestro-release-note:27f3b8ecfeec -->
- [maestro] Fix swarm validation follow-up bugs. <!-- maestro-release-note:0aa2c1ebadbf -->
- Harden non-interactive cleanup shutdown. <!-- maestro-release-note:335cdf520874 -->
- Fix review feedback none threshold. <!-- maestro-release-note:0603017a7248 -->
- Fix exec replay shutdown after headless runs. <!-- maestro-release-note:d8d867bea70f -->
- Improve swarm validation controls. <!-- maestro-release-note:915f74b61d6f -->
- [maestro] persist learned guidelines for the incident-triage skill. <!-- maestro-release-note:475b14d4e805 -->
- [maestro] Ensure objective_id is set for codex worker operating-chat requests (#2845). <!-- maestro-release-note:893fd1c6cbdb -->
- [maestro] Normalize empty objective_id to undefined in correlation normalizer (#2844). <!-- maestro-release-note:282ffb2f9f6a -->

### Fixed

- Allow Devin PR summaries in feedback audit. <!-- maestro-release-note:670c31329ab7 -->
- Align A2A workspace header precedence. <!-- maestro-release-note:22e8422b35a2 -->
- Skip missing product-copy roots in naming-consistency walk (#2833). <!-- maestro-release-note:5f9c9cb0b64c -->
- Rewrite public Bzlmod module name during public mirror prep (#2830). <!-- maestro-release-note:7b22cd8f7374 -->
- Treat unguarded Rust test modules as package-impacting (#2829). <!-- maestro-release-note:1377c327f205 -->
- Ignore orphaned tracked handoff items. <!-- maestro-release-note:f76dea589c8a -->
- Dedupe legacy handoff follow-ups. <!-- maestro-release-note:e6490dc0c032 -->
- Preserve valid open todo handoffs. <!-- maestro-release-note:d8fc9c6b536e -->
- Align customer value period scoping. <!-- maestro-release-note:d4b37a4a37f0 -->

## [0.10.50] - 2026-06-18

### Added

- Migrate OpenTelemetry exporter module-load reads to RuntimeEnv (#2783). <!-- maestro-release-note:4e4c3aeec5bc -->
- Migrate meter fallback to resolveOrganizationIdFromOAuthCredentials (#2780). <!-- maestro-release-note:94fd92045c54 -->
- Migrate hasRemoteMeterDestination to consume RuntimeEnv (#2777). <!-- maestro-release-note:271e51f8e6a7 -->
- Permanent exploit-vector regression suite + OAuth test isolation (#2766). <!-- maestro-release-note:db1a1859c56a -->
- Rotate-on-parse-fail for persisted JSON state (#2631) (#2734). <!-- maestro-release-note:c67088bdd211 -->
- /skills trust UX for the prompt-trust cache (#2629) (#2733). <!-- maestro-release-note:ee310419fa98 -->
- MultiClientSessionAccessControl impl (#2641) (#2731). <!-- maestro-release-note:87fd6caca58c -->
- Move tokens from plaintext file to OS keychain (#2611) (#2729). <!-- maestro-release-note:141d21360aa3 -->
- Wire SessionAccessControl into HostedSessionManager (#2641) (#2724). <!-- maestro-release-note:d8692e272efc -->
- Enforce trust gate + lock AccessControl binding (#2722). <!-- maestro-release-note:5684559db1ef -->
- Stronger controls — trust cache, path-confine, AccessControl scaffold (#2721). <!-- maestro-release-note:cd53cac465d9 -->
- Emit contentSha alongside loaded skills (#2629) (#2720). <!-- maestro-release-note:b8f408d83cae -->

### Changed

- Add operating layer backend persistence (#2789). <!-- maestro-release-note:ba507fd32b3b -->
- Add operating layer platform primitives. <!-- maestro-release-note:b5735cb3ce5d -->
- [maestro] fix(runtime): centralize finalized env bootstrap (#2786). <!-- maestro-release-note:811b6585548d -->
- [maestro] feat(substrate): migrate src/opentelemetry.ts MAESTRO_OTEL_* reads to RuntimeEnv (#2784). <!-- maestro-release-note:878ab1165fc2 -->
- [maestro] feat(substrate): extend Settings.telemetry, migrate isBeaconEnabled to take Settings["telemetry"] (#2782). <!-- maestro-release-note:969bc8426066 -->
- [maestro] feat(runtime): Settings primitive — typed composed substrate (Week 2 PR 2) (#2781). <!-- maestro-release-note:850fdda30a75 -->
- [maestro] feat(runtime): settings-reads scanner + ratchet (Week 2 PR 1) (#2779). <!-- maestro-release-note:5b5db6a13752 -->
- [maestro] feat(runtime): factor resolveOrganizationId into env-side and OAuth-disk primitives (#2778). <!-- maestro-release-note:3f79e78e3fb7 -->
- [maestro] feat(runtime): RuntimeEnv substrate + Logger migration + env-reads ratchet (#2776). <!-- maestro-release-note:6e025d6c3faa -->
- Bump actions/setup-java from 4.7.1 to 5.3.0 (#2774). <!-- maestro-release-note:df640ac35b8b -->
- [maestro] fix(safety): scan bash command strings for mid-string URLs in network policy (#2773). <!-- maestro-release-note:a1bb966e51f9 -->
- [maestro] fix(desktop): pass raw sessionId (not "default") to composer API (#2771). <!-- maestro-release-note:2030c97ef373 -->

### Fixed

- Address recent review feedback (#2785). <!-- maestro-release-note:b91a857ef801 -->
- Include #-prefix tokens in URL scan to close quoted-hash bypass (#2775). <!-- maestro-release-note:60e9d6076311 -->
- Clear flush timer when global aggregator is reset (#2772). <!-- maestro-release-note:fcf1eef587e8 -->
- Make config lazy so env mutations after import still take effect (#2769). <!-- maestro-release-note:34f46e265b77 -->
- Scope composer to sessionKey + clear stale state on fetch failure (#2767). <!-- maestro-release-note:09792182d3c1 -->
- Add resetOAuthStorageForTests to cli.integration before/after (#2762). <!-- maestro-release-note:7da82628a84c -->
- Force file-mode OAuth in two more leak-vulnerable test files (#2761). <!-- maestro-release-note:0e64f11c57fe -->
- Isolate test OAuth and telemetry state to prevent cross-test pollution (#2752). <!-- maestro-release-note:bbc2bc8ef968 -->
- Adversarial-review round 2 — close residual bugs in batch1/2/3 fixes (#2750). <!-- maestro-release-note:27a95e3c0652 -->
- Adversarial-review batch 3 — trust hash, OAuth sentinel, drop PPID heuristic (#2629, #2611, #2481) (#2749). <!-- maestro-release-note:9047393fd410 -->
- Adversarial-review batch 2 — admin split + HostedSessionManager gates (#2641) (#2747). <!-- maestro-release-note:7127a2730ba9 -->
- Adversarial-review fixes batch 1 (#2641, #2611, #2481, #2629, #2631) (#2746). <!-- maestro-release-note:af0049548b49 -->

## [0.10.48] - 2026-05-30

### Changed

- Gate public mirror published verification scripts (#2361). <!-- maestro-release-note:e47d3cb174d4 -->
- Rerun release-auth checks. <!-- maestro-release-note:79b5f14693f4 -->
- Remove timing flake from rust tui tests. <!-- maestro-release-note:6afafcde7a15 -->
- Lock A2A stage gate evidence ids. <!-- maestro-release-note:73e227c68bf2 -->
- Gate published replay evidence verifier. <!-- maestro-release-note:52a6ef07d804 -->
- Give ghcr image builds more headroom. <!-- maestro-release-note:96aca1a604dc -->
- Document live smoke evidence inputs. <!-- maestro-release-note:123a4a481fad -->
- Move Slack scenarios to Platform runtime refs (#2347). <!-- maestro-release-note:61245c594cdb -->

### Fixed

- Refresh maestro from release metadata on startup (#2360). <!-- maestro-release-note:0a81cbc261ba -->
- Verify full deprecation range on rerun. <!-- maestro-release-note:26ad24a575d0 -->
- Make npm deprecation reruns idempotent. <!-- maestro-release-note:c8c4d44560c3 -->
- Bundle Codex app-server integration. <!-- maestro-release-note:657ca196960f -->
- Lock tui rust dependencies for public ci. <!-- maestro-release-note:3b7472e79f22 -->
- Retire ensemble footer mode (#2350). <!-- maestro-release-note:c71b0f4cd7b8 -->
- Consume runtime signals only (#2349). <!-- maestro-release-note:539894730a32 -->

## [0.10.47] - 2026-05-29

### Changed

- Recover login when refresh fails (#2346). <!-- maestro-release-note:f2ceab065c0f -->
- Rename sandbox proof surface to checks. <!-- maestro-release-note:efe1907cf01d -->
- Avoid refreshing passive auth probes (#2345). <!-- maestro-release-note:00018d636738 -->
- Surface app-server auth in tui status. <!-- maestro-release-note:d390030bc9f0 -->
- Align login with app-server auth. <!-- maestro-release-note:a0131380881b -->
- Keep ripgrep guard public-safe. <!-- maestro-release-note:db78b72d5fc6 -->
- Mirror ripgrep helper release action. <!-- maestro-release-note:7255e7a9975e -->
- Harden ripgrep setup and background log rotation. <!-- maestro-release-note:716e558f5c33 -->
- Record Slack delivery runtime events (#2337). <!-- maestro-release-note:838e72f7d4c5 -->
- Add teammate Slack delivery queue (#2331). <!-- maestro-release-note:d3e986d2bf10 -->
- Smoke already-published registry releases (#2335). <!-- maestro-release-note:3d1f6d3a7cc5 -->
- Cover legacy broken release range (#2334). <!-- maestro-release-note:22d7ef756cfe -->

### Fixed

- Preserve delivered slack finals. <!-- maestro-release-note:9478ca17aae6 -->
- Bind durable a2a push message ids (#2336). <!-- maestro-release-note:4c34b9ff45d1 -->
- Keep tag-release published no-op in source (#2333). <!-- maestro-release-note:6cba565f53bd -->

## [0.10.46] - 2026-05-28

### Fixed

- Foreground current request literals. <!-- maestro-release-note:b9ac6b5c93ef -->

## [0.10.45] - 2026-05-28

### Changed

- Harden Platform A2A live evidence ids (#2324). <!-- maestro-release-note:8064054b7ec7 -->
- Release package-impacting follow-up changes under v0.10.45 while keeping the
  tag-release version guard strict.
- Harden hosted runner continuity evidence. <!-- maestro-release-note:a0e4b937ee8e -->

### Fixed

- Preserve requested deploy identifiers. <!-- maestro-release-note:fa4a2e7f9429 -->

## [0.10.44] - 2026-05-28

### Changed

- Harden hosted runner continuity evidence. <!-- maestro-release-note:a0e4b937ee8e -->
- Require public release tag mismatches with package-impacting changes to use a
  new package version.

### Fixed

- Release post-v0.10.43 package changes under v0.10.44 instead of silently
  skipping the public tag guard.

## [0.10.43] - 2026-05-28

### Changed

- Harden release smoke conformance gates. <!-- maestro-release-note:2e08ee188332 -->
- Simplify teammate runtime surface. <!-- maestro-release-note:736c201f0f42 -->
- Gate published replay lifecycle evidence (#2316). <!-- maestro-release-note:efaa8396bf9f -->
- Harden Bun runtime package smoke (#2314). <!-- maestro-release-note:81b82f5fd1b0 -->
- Gate published replay ToolExecution evidence (#2312). <!-- maestro-release-note:b7593028a1d8 -->
- Gate queryable replay observability (#2311). <!-- maestro-release-note:5d907d6476a4 -->
- Gate published replay search evidence (#2310). <!-- maestro-release-note:e781ffc42d54 -->
- Harden release surface gate scripts. <!-- maestro-release-note:52e5b469a427 -->
- Verify published replay provider config mirrors. <!-- maestro-release-note:db33aac1117f -->
- Require deterministic published replay provider config. <!-- maestro-release-note:20ccb579d520 -->
- Gate published replay provider transcript evidence. <!-- maestro-release-note:85d27c1a856b -->

### Fixed

- Harden ripgrep path errors and replay error evidence (#2307). <!-- maestro-release-note:2d2352fdcfa1 -->

## [0.10.42] - 2026-05-28

### Changed

- Harden Bun runtime package smoke (#2314). <!-- maestro-release-note:81b82f5fd1b0 -->
- Gate published replay ToolExecution evidence (#2312). <!-- maestro-release-note:b7593028a1d8 -->
- Gate queryable replay observability (#2311). <!-- maestro-release-note:5d907d6476a4 -->
- Gate published replay search evidence (#2310). <!-- maestro-release-note:e781ffc42d54 -->
- Harden release surface gate scripts. <!-- maestro-release-note:52e5b469a427 -->
- Verify published replay provider config mirrors. <!-- maestro-release-note:db33aac1117f -->
- Require deterministic published replay provider config. <!-- maestro-release-note:20ccb579d520 -->
- Gate published replay provider transcript evidence. <!-- maestro-release-note:85d27c1a856b -->

### Fixed

- Harden ripgrep path errors and replay error evidence (#2307). <!-- maestro-release-note:2d2352fdcfa1 -->

## [0.10.41] - 2026-05-27

### Changed

- Gate published replay ToolExecution evidence (#2312). <!-- maestro-release-note:b7593028a1d8 -->
- Gate queryable replay observability (#2311). <!-- maestro-release-note:5d907d6476a4 -->
- Gate published replay search evidence (#2310). <!-- maestro-release-note:e781ffc42d54 -->
- Harden release surface gate scripts. <!-- maestro-release-note:52e5b469a427 -->
- Verify published replay provider config mirrors. <!-- maestro-release-note:db33aac1117f -->
- Require deterministic published replay provider config. <!-- maestro-release-note:20ccb579d520 -->
- Gate published replay provider transcript evidence. <!-- maestro-release-note:85d27c1a856b -->

### Fixed

- Harden ripgrep path errors and replay error evidence (#2307). <!-- maestro-release-note:2d2352fdcfa1 -->

## [0.10.40] - 2026-05-27

### Changed

- Harden release surface gate scripts. <!-- maestro-release-note:52e5b469a427 -->
- Verify published replay provider config mirrors. <!-- maestro-release-note:db33aac1117f -->
- Require deterministic published replay provider config. <!-- maestro-release-note:20ccb579d520 -->
- Gate published replay provider transcript evidence. <!-- maestro-release-note:85d27c1a856b -->

### Fixed

- Harden ripgrep path errors and replay error evidence (#2307). <!-- maestro-release-note:2d2352fdcfa1 -->

## [0.10.39] - 2026-05-27

### Changed

- Drain ripgrep retry promise cleanup. <!-- maestro-release-note:0f3181530fe5 -->
- Guard published package canary env. <!-- maestro-release-note:e73fa66a32ab -->
- [maestro] Guard deprecation message drift (#2299). <!-- maestro-release-note:c310c97ba937 -->

### Fixed

- Reset aborted ripgrep installs for retries. <!-- maestro-release-note:b1066de6caaf -->
- Dedupe abortable ripgrep installs. <!-- maestro-release-note:a4ce5f223417 -->
- Harden managed tool aborts and A2A stream IDs. <!-- maestro-release-note:307bcf6fdd35 -->

## [0.10.38] - 2026-05-27

### Changed

- Gate rpc protocol conformance (#2295). <!-- maestro-release-note:912ccaf53f1f -->
- [maestro] Gate Platform runtime conformance (#2276). <!-- maestro-release-note:219cc0c215cd -->
- Gate tool attempts in release telemetry (#2293). <!-- maestro-release-note:b26aff814445 -->
- Avoid guardian token fixture false positive (#2292). <!-- maestro-release-note:02deab8d5c8c -->
- [maestro] Propagate A2A Platform trace context (#2272). <!-- maestro-release-note:d05f3195f0c8 -->

### Fixed

- Preserve public release helper ownership (#2297). <!-- maestro-release-note:47e1fb085071 -->
- Resolve ripgrep through managed tools (#2296). <!-- maestro-release-note:a8ff81cea99d -->
- Avoid DNS for host policy denies (#2294). <!-- maestro-release-note:215d3295c580 -->
- Trim public install audit surface. <!-- maestro-release-note:c7a8b96bb3fe -->

## [0.10.37] - 2026-05-27

### Changed

- Honor shell env policy for trusted tool tokens. <!-- maestro-release-note:d0672967bd20 -->

## [0.10.36] - 2026-05-27

### Fixed

- Honor shell env policy for platform credentials. <!-- maestro-release-note:bebe6c199b90 -->

## [0.10.35] - 2026-05-27

### Fixed

- Honor shell env policy for platform credentials. <!-- maestro-release-note:14780834d753 -->

## [0.10.34] - 2026-05-27

### Fixed

- Preserve platform worker tool credentials. <!-- maestro-release-note:7ec95fe0748f -->

## [0.10.33] - 2026-05-27

### Changed

- Fix published replay evidence mode coverage (#2286). <!-- maestro-release-note:c1bc8e66dd4f -->

## [0.10.32] - 2026-05-26

### Changed

- Fix find leading globstar root matches (#2283). <!-- maestro-release-note:820b73e77e71 -->
- Fix published replay approval artifact evidence (#2282). <!-- maestro-release-note:a4c938587c2a -->
- [maestro] Gate release surface conformance (#2274). <!-- maestro-release-note:2ed7226811b5 -->
- [maestro] Improve deprecate-release auth diagnostics (#2278). <!-- maestro-release-note:6ded1a8ecca0 -->
- Gate Maestro release observability catalog. <!-- maestro-release-note:0338651eada9 -->
- Prove headless utility cleanup replay. <!-- maestro-release-note:8b2b5b574900 -->
- Split A2A discovery helpers (#2267). <!-- maestro-release-note:9fdc1f4a5920 -->
- Split tools package panel (#2270). <!-- maestro-release-note:11dbf3e7363a -->
- [maestro] Preserve A2A push trace context (#2273). <!-- maestro-release-note:db88392aba25 -->
- Gate published replay evidence. <!-- maestro-release-note:17c58a286e30 -->
- [maestro] Fence Platform A2A push callbacks (#2277). <!-- maestro-release-note:73d1adc92e78 -->
- Gate CLI runtime conformance (#2275). <!-- maestro-release-note:3962e2f82496 -->

### Fixed

- Preserve Windows grep fallback shell (#2281). <!-- maestro-release-note:20ceaa0e57fd -->
- Keep search result limits per file (#2280). <!-- maestro-release-note:dcaac8a4fa2b -->
- Harden registry process tests on public runners (#2279). <!-- maestro-release-note:0a7705b59092 -->
- Harden TUI search and A2A registration traces. <!-- maestro-release-note:8bea2a6316d1 -->
- Registry-smoke public fallback publishes. <!-- maestro-release-note:92c21c412d65 -->

## [0.10.31] - 2026-05-26

### Changed

- Fix ripgrep search errors and MarkItDown timeout flake (#2260). <!-- maestro-release-note:c2bfc86421c4 -->
- Extract compaction cut point helpers (#2259). <!-- maestro-release-note:752cedcc7e97 -->

## [0.10.30] - 2026-05-26

### Changed

- Extract transport event helpers. <!-- maestro-release-note:354ee66696bb -->
- Expose AgentRuntime ledger correlation joins. <!-- maestro-release-note:5c5344ac5fa9 -->

## [0.10.29] - 2026-05-26

### Changed

- Extract native read-only tool batching (#2253). <!-- maestro-release-note:40501a390b70 -->
- Fix parallel ripgrep error reporting. <!-- maestro-release-note:142d584de5a0 -->

## [0.10.28] - 2026-05-26

### Changed

- Gate A2A live proof on discovery evidence (#2252). <!-- maestro-release-note:c84c85430b2b -->
- [maestro] Extract headless runtime broker (#2251). <!-- maestro-release-note:32303b1ad1c7 -->
- Prove run inspection durability in replay smoke (#2250). <!-- maestro-release-note:73cf071a8a9f -->
- Extract TypeScript godfile helpers (#2249). <!-- maestro-release-note:068ec2c18739 -->
- Prove AgentRuntime ledger in published replay smoke. <!-- maestro-release-note:63b42c06dd24 -->
- Extract TUI state and swarm tests (#2239). <!-- maestro-release-note:7767debf7bdc -->
- Extract composer chat attachment helpers (#2246). <!-- maestro-release-note:1a2dccd12401 -->
- Link AgentRuntime ledger work items to ToolExecution. <!-- maestro-release-note:04ff186ee2f2 -->
- Keep package search responses ordered. <!-- maestro-release-note:85a580b35e27 -->
- Load package settings after client binding. <!-- maestro-release-note:26235dfae382 -->
- Guard public release install metadata checks. <!-- maestro-release-note:c9406edae411 -->
- Extract package settings component (#2240). <!-- maestro-release-note:c8add73a479c -->

## [0.10.25] - 2026-05-25

### Changed

- Guard release tags against stale package versions (#2227). <!-- maestro-release-note:0759b5ac0939 -->
- Extract hosted runner config (#2229). <!-- maestro-release-note:a1f91301c920 -->
- Update operating-layer anchor path. <!-- maestro-release-note:da0948b4e192 -->
- Fix operating-layer anchors after headless state split. <!-- maestro-release-note:968a4149e651 -->
- Move headless supervisor tests. <!-- maestro-release-note:e1728b257db0 -->
- Extract headless message state reducer. <!-- maestro-release-note:60c633f683cd -->
- Extract control-plane chat helpers. <!-- maestro-release-note:9c9e035eba18 -->
- Extract A2A push notifications. <!-- maestro-release-note:980257a59f2d -->
- Clean release note branding. <!-- maestro-release-note:78909d1cdd48 -->
- Use Maestro branding in release note. <!-- maestro-release-note:16c1fbe34ac2 -->

## [0.10.24] - 2026-05-25

### Changed

- Clean up Maestro product branding. <!-- maestro-release-note:8ba91124c49a -->
- Update Codex operating-layer evidence paths (#2217). <!-- maestro-release-note:51842842c9e7 -->
- Extract control-plane local helpers (#2215). <!-- maestro-release-note:7ede1bd34c23 -->
- Extract control-plane Codex bridge helpers (#2216). <!-- maestro-release-note:e06f1a7a66db -->
- Revoke legacy Anthropic connector links on logout (#2212). <!-- maestro-release-note:129499bdcd24 -->
- Handle legacy Anthropic OAuth cleanup (#2209). <!-- maestro-release-note:9558e5ee4db8 -->
- Extract control-plane session helpers (#2207). <!-- maestro-release-note:37f5e30102fc -->
- Default Maestro auth to Codex (#2202). <!-- maestro-release-note:32c2e64bce88 -->
- Update Codex parity anchors for TUI splits (#2203). <!-- maestro-release-note:e50996157c2d -->
- Extract hosted runner manifests (#2205). <!-- maestro-release-note:850d7511ae64 -->
- Extract tool registry execution dispatcher (#2206). <!-- maestro-release-note:e120c11987a1 -->
- Extract TUI app session recording helpers (#2201). <!-- maestro-release-note:29b3ea1e6690 -->

## [0.10.23] - 2026-05-23

### Changed

- Keep published replay canary portable. <!-- maestro-release-note:85b028901cd7 -->
- Fix Fathom CUA smoke proof state (#2137). <!-- maestro-release-note:68edd64c02f8 -->
- Tighten published replay sandbox guardrail. <!-- maestro-release-note:80472c301963 -->
- Assert published replay sandbox default. <!-- maestro-release-note:ccd4b73fe8c1 -->
- Require release canary guardrail. <!-- maestro-release-note:3f8dd44ebd6b -->
- Keep published replay sandbox default covered. <!-- maestro-release-note:142c634875cf -->
- Harden release and public mirror automation (#2136). <!-- maestro-release-note:18c790c79014 -->
- Harden artifact replay contracts. <!-- maestro-release-note:c096cfde59ed -->
- Automate public parity branch upkeep. <!-- maestro-release-note:144de48afba8 -->

## [0.10.22] - 2026-05-23

### Added

- Prove A2A swarm push work graph (#2099). <!-- maestro-release-note:b1f0e8e9a42f -->

### Changed

- Keep public ci timeout guardrail portable (#2132). <!-- maestro-release-note:a8d4b09d27ff -->
- Harden Bun registry replay smoke (#2131). <!-- maestro-release-note:c60a4b76f31e -->
- Add Maestro operator control-plane improvements (#2102). <!-- maestro-release-note:e02197f75adc -->
- Expand A2A local swarm proof (#2117). <!-- maestro-release-note:0b0c9af887a0 -->
- Guard hosted retry wait coalescing (#2129). <!-- maestro-release-note:a2f32058d0db -->
- Tolerate public ci workflow in codegen guardrail (#2130). <!-- maestro-release-note:630b9a817f7f -->
- Add failed tool-call event catalog subject (#2127). <!-- maestro-release-note:5ed2ebb69cf7 -->
- Harden registry release smoke and Guardian runtime proof (#2122). <!-- maestro-release-note:11e0bad42535 -->
- Normalize integration service port guardrail (#2125). <!-- maestro-release-note:2da12d21b445 -->
- Preserve Guardian timeout exit codes (#2121). <!-- maestro-release-note:737cff3aa0a2 -->
- Codex tool profiles and focused Fathom CUA proof matrix (#2112). <!-- maestro-release-note:a89b36b414a4 -->
- Record hosted runtime evidence events (#2101). <!-- maestro-release-note:7b94cbac2fde -->

### Fixed

- Treat blank rustfmt overrides as disabled (#2128). <!-- maestro-release-note:4befad9e79b9 -->
- Harden artifact runtime reconstruction (#2124). <!-- maestro-release-note:00b306b4f90f -->
- Recover status database probes after timeout (#2123). <!-- maestro-release-note:e203b1621f5b -->
- Require public mirror source sha (#2113). <!-- maestro-release-note:50b1a534330e -->
- Require fresh Fathom CUA action proof state (#2120). <!-- maestro-release-note:dd5d851a1573 -->
- Reduce avoidable tool serialization (#2108). <!-- maestro-release-note:6bda4a5d45e4 -->
- Reconcile public workspace glob fallback (#2107). <!-- maestro-release-note:582542106f95 -->
- Preserve public release smoke parity (#2104). <!-- maestro-release-note:9b155949bcf8 -->

## [0.10.21] - 2026-05-22

### Changed

- Add Platform-owned A2A delegation (#2080). <!-- maestro-release-note:f30599cbae56 -->
- Reduce avoidable tool serialization (#2079). <!-- maestro-release-note:cde1f5c1a424 -->

### Fixed

- Vendor runtime workspaces under `dist/node_modules` so Bun and npm installs of
  `@evalops/maestro` do not resolve unpublished `@evalops/contracts` or
  `@evalops/tui` packages from the registry. <!-- maestro-release-note:449e0b2ad97f -->
- Allow public mirror ci guardrail shape (#2092). <!-- maestro-release-note:e5749b2d000b -->

## [0.10.20] - 2026-05-22

### Changed

- Add Platform A2A control and evidence guardrails (#2065). <!-- maestro-release-note:a174de22308e -->
- Skip TS checks for Rust-only PRs (#2078). <!-- maestro-release-note:de04550846b8 -->
- Fix public mirror review blockers (#2074). <!-- maestro-release-note:5075220752bf -->
- Expose tool scheduling diagnostics (#2072). <!-- maestro-release-note:3613ab6e7a64 -->
- Report avoidable tool serialization (#2071). <!-- maestro-release-note:c1ffa9e1f331 -->
- Recognize EvalOps platform base URL aliases (#2063). <!-- maestro-release-note:341c3e6ae5ed -->
- Skip rust setup for workflow-only tui checks (#2069). <!-- maestro-release-note:6ae0842947a7 -->
- Scope rust hook coverage (#2066). <!-- maestro-release-note:5e5d9cf3e02b -->
- Add next wave tool scheduling gates (#2064). <!-- maestro-release-note:5b3b061e2b3d -->
- Log control-plane startup on stdout (#2062). <!-- maestro-release-note:cd1f81614933 -->
- Parallelize read-only tool waves (#2061). <!-- maestro-release-note:03f8a287b9c1 -->
- Run authorship labeler on owned ci (#2059). <!-- maestro-release-note:3b71c588b1b8 -->

### Fixed

- Publish Maestro's runtime workspace packages before the public root package so
  Bun and npm resolvers can install `@evalops/maestro` without registry 404s.
- Run nix hash updater on hosted runner (#2082). <!-- maestro-release-note:2ae7fb184dfc -->
- Support Anthropic Opus 4.7 runtime (#2076). <!-- maestro-release-note:d047c05f1a4d -->
- Reject unsafe trusted runner roots (#2077). <!-- maestro-release-note:caa544bc2dae -->
- Preserve tool concurrency cap (#2073). <!-- maestro-release-note:c5811f2dc910 -->
- Support split-stream structured logs (#2060). <!-- maestro-release-note:4ab6fac8eb1d -->

## [0.10.19] - 2026-05-18

### Added

- Enrich Codex subagent work graph edges. <!-- maestro-release-note:59b55a277ef8 -->
- Route swarm subagents by mode (#2015). <!-- maestro-release-note:d0b8837d307a -->
- Render codex subagent edge metadata (#1990). <!-- maestro-release-note:0cca67ca6d7d -->
- Add agent operating plane telemetry context (#1987). <!-- maestro-release-note:4d878c0f2b26 -->
- Add OSS skill publish install contract (#1984). <!-- maestro-release-note:e46cde8187e7 -->
- Add first-party operational skill packages (#1982). <!-- maestro-release-note:e1493a309a14 -->
- Add local AgentRuntime ledger projection (#1974). <!-- maestro-release-note:972982cfe11c -->
- Continue actionable A2A tasks. <!-- maestro-release-note:7654da2213df -->
- Record subagent delegations (#1954). <!-- maestro-release-note:87787f61a321 -->
- Enroll Maestro runtime errors in Sentry (#1923). <!-- maestro-release-note:e703acc96af6 -->
- Add Fermata LLM rubric suite option (#1919). <!-- maestro-release-note:aa71028c5b73 -->
- Enforce staged rollout surfaces (#1883). <!-- maestro-release-note:6065a68afc07 -->

### Changed

- Add Platform-backed A2A peer discovery (#2019). <!-- maestro-release-note:6d3578ea6a9a -->
- [maestro] Add regular release cadence (#2016). <!-- maestro-release-note:12093787b18e -->
- Record Platform drain evidence for hosted runners (#2018). <!-- maestro-release-note:761c4b2a09db -->
- A2a: advertise governed subagent skills (#2013). <!-- maestro-release-note:722ef3cd5a07 -->
- Dispatch Maestro image sync after publish (#2011). <!-- maestro-release-note:02f18d7976f9 -->
- A2a: ack Platform push callbacks in Rust control plane (#2008). <!-- maestro-release-note:7472e65f26bd -->
- Expose operating-plane value proof in CLI (#2007). <!-- maestro-release-note:2d67d5abe37a -->
- Summarize operating plane value proof (#2006). <!-- maestro-release-note:e3c41b9e6755 -->
- Add operating plane lookup client (#2005). <!-- maestro-release-note:d64692df1988 -->
- A2a: receive Platform push callbacks (#2003). <!-- maestro-release-note:a3e9b6e79333 -->
- Managed gateway: emit AgentRuntime ledger metadata (#2002). <!-- maestro-release-note:0f40f79bf4d6 -->
- Fix A2A push config identity (#2001). <!-- maestro-release-note:fbff816deb01 -->

### Fixed

- Preserve distinct request metadata ids (#2014). <!-- maestro-release-note:432f3080cfaa -->
- Forward managed gateway thread metadata (#2012). <!-- maestro-release-note:f21816d1134f -->
- Keep spawned subagent work active (#2010). <!-- maestro-release-note:54efa3fb9373 -->
- Accept platform A2A push callbacks (#2009). <!-- maestro-release-note:19a53943d816 -->
- Redact A2A push secrets in task responses (#2000). <!-- maestro-release-note:3e37808837fc -->
- Share codex subagent protocol constants (#1993). <!-- maestro-release-note:d4e8036240e6 -->
- Unwrap A2A JSON-RPC stream envelopes (#1991). <!-- maestro-release-note:b3cfc7d93a6c -->
- Avoid CRLF SSE boundary backtracking (#1992). <!-- maestro-release-note:544634f0f393 -->
- Propagate A2A ledger aborts (#1983). <!-- maestro-release-note:0172f46663e0 -->
- Recover stale A2A ledger locks within one attempt (#1981). <!-- maestro-release-note:bb0e5e8cca80 -->
- Preserve repeated A2A reply turns. <!-- maestro-release-note:21c8e17c0fe0 -->
- Skip terminal A2A refreshes (#1976). <!-- maestro-release-note:2e0eed9390f5 -->

## [0.10.18] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.17] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.16] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.15] - 2026-05-06

### Added

- Added any-agent EvalOps control-plane profile metadata for managed runtime, MCP/OTLP shims, durable memory mode, and runtime ownership across the CLI bootstrap flow, managed context, MCP plugin headers, and Rust event bus extensions.

### Changed

- Published the public package/release train with the any-agent registry wiring that landed through the internal source-of-truth mirror.

### Fixed


## [0.10.14] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.13] - 2026-05-06

### Added

### Changed

### Fixed


## [0.10.12] - 2026-05-05

### Added

### Changed

### Fixed


## [0.10.11] - 2026-05-04

### Added

### Changed

### Fixed


## [0.10.10] - 2026-05-03

### Added

### Changed

### Fixed


## [0.10.9] - 2026-05-03

### Added

### Changed

### Fixed


## [0.10.8] - 2026-04-22

### Changed

- Bumped OpenTelemetry runtime instrumentation packages to clear the release audit gate.

### Fixed

- Forced transitive Hono installs to the patched JSX SSR handling release.

## [0.10.7] - 2026-04-22

### Added

- Added an npm token fallback for the release workflow while the `@evalops/maestro`
  trusted publisher is configured.

### Changed

- Moved the public package namespace from `@evalops-jh/maestro` to
  `@evalops/maestro` and updated install references.

## [0.10.6] - 2026-04-15

### Changed

- Rebundled Google provider runtime dependencies into the built CLI and provider artifacts so installs no longer need the Google SDKs as direct runtime package requirements.

### Fixed

- Removed the unused root `better-sqlite3` dependency from the published package and eliminated the remaining install-time deprecation warnings from `prebuild-install` and `node-domexception`.
- Hardened runtime dependency verification so bundled code comments do not produce false positives during release validation.

## [0.10.5] - 2026-04-15

### Changed

- Tightened shared Bun cache keying in CI and release workflows to use exact, versioned cache hits instead of broad fallback restores.

### Fixed

- Prevented stale Bun cache restores on Linux release runners from causing `bun install --frozen-lockfile` to rewrite state and fail the publish pipeline.

## [0.10.4] - 2026-04-15

### Changed

- Updated GitHub Actions pins to current Node 24-compatible releases and replaced the deprecated cache action in shared CI/release setup.
- Refreshed direct runtime dependencies including `glob`, `otplib`, `@google/genai`, `google-auth-library`, and `better-sqlite3`.

### Fixed

- Migrated TOTP generation and verification to `otplib` v13 while preserving Maestro's existing 6-digit, 30-second, one-step drift behavior.
- Removed the package's direct install-time deprecation warnings from outdated `glob` and `otplib` releases.

## [0.10.3] - 2026-04-15

### Fixed

- Treat `tree-sitter` and `tree-sitter-bash` as optional install-time dependencies so Linux/Node 24 consumers can install Maestro even when native parser bindings are unavailable.

## [0.10.2] - 2026-04-15

### Fixed

- Cut the follow-up release after the initial trusted publishing migration.

## [0.10.1] - 2026-04-15

### Changed

- Switched npm release automation for `@evalops-jh/maestro` to GitHub trusted publishing via OIDC.

### Fixed

- Replaced published `workspace:*` internal dependency specifiers with concrete package versions in release manifests.
- Removed the need for a stored GitHub Actions npm token during package publication.

## Legacy Unreleased Notes

### Added

- **Jupyter Notebook Support**: New `notebook_edit` tool for editing `.ipynb` files at the cell level with `replace`, `insert`, and `delete` modes. The `read` tool now displays notebooks with formatted cell output.
- **PDF Reading**: The `read` tool now extracts and displays text content from PDF files using `pdf-parse`.
- **Image Processing with Sharp**: Optional `sharp` dependency for automatic image optimization before sending to LLMs. Reduces token usage by resizing large images and compressing screenshots.
- **System Reminder Injection**: New `SystemReminderManager` for injecting contextual reminders (e.g., todo list prompts, read-before-edit hints) into conversations via `<system-reminder>` tags.
- **Structured Questions**: New `ask_user` tool for gathering user input with predefined options (2-4 choices per question, multi-select support, automatic "Other" option).
- **SDK Tool Types**: Exported TypeBox schemas and TypeScript types for all built-in tools via `@evalops/composer/sdk-tools` for external SDK consumers.
- **Agent Resume Capability**: New `AgentTranscript` system for persisting and resuming agent executions, with `FileTranscriptStore` and `MemoryTranscriptStore` implementations.
- **Auto-Compaction System**: New `AutoCompactionMonitor` that automatically triggers conversation compaction when context window usage exceeds configurable thresholds. Environment variables: `MAESTRO_AUTOCOMPACT_PCT` (default: 85), `MAESTRO_AUTOCOMPACT_ENABLED`, `MAESTRO_AUTOCOMPACT_MIN_MESSAGES`.
- **Git State Tracking**: Extended git utilities with `getGitState()`, `getCommitSha()`, `getCurrentBranch()`, `isDirtyWorkingTree()`, and `getAheadBehind()` for comprehensive repository state tracking.
- **Business Telemetry Metrics**: New telemetry events for session tracking (`session.count`, `session.duration`), token usage (`tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_write`), cost tracking (`cost.usd`), compaction events, and model switches.
- **Sandbox Violation Tracking**: New `recordSandboxViolation()` function for security auditing of blocked, warned, and allowed sandbox events.
- **Plan Mode Persistence**: New plan mode system with `enterPlanMode()`, `exitPlanMode()`, `writePlanFile()`, and file-based state persistence. Plan files are stored in `.maestro/plans/` with session and git state metadata.
- **Session Auto-Recovery**: New `SessionRecoveryManager` for automatic session backup and recovery. Includes periodic backups, recovery from crashes, and cleanup of expired backups. Environment variables: `MAESTRO_SESSION_RECOVERY_ENABLED`, `MAESTRO_SESSION_BACKUP_DIR`, `MAESTRO_SESSION_BACKUP_INTERVAL`.
- **IDE Auto-Connect**: New `IDEAutoConnectManager` that detects and tracks running IDEs (VS Code, Cursor, Windsurf, JetBrains IDEs, Vim, Neovim, Emacs, Sublime, Zed). Environment variables: `MAESTRO_IDE_AUTOCONNECT`, `MAESTRO_IDE_SCAN_PORTS`, `MAESTRO_IDE_TIMEOUT`.
- `MAESTRO_TRUST_PROXY` environment variable to trust `X-Forwarded-For` headers for rate limiting when behind a reverse proxy.
- `MAESTRO_TRUST_PROXY_HOPS` environment variable (default: 1) to configure number of trusted proxy hops for multi-proxy setups.

### Changed

- **BREAKING**: Removed legacy Anthropic OAuth fallback (`anthropic-oauth.json`). Users must re-authenticate using the new OAuth system (`oauth.json`) via `maestro anthropic login`. The legacy credential file is no longer read.
- **BREAKING**: Rate limiting now uses `socket.remoteAddress` by default instead of `X-Forwarded-For`. Deployments behind reverse proxies (nginx, CloudFlare, load balancers) must set `MAESTRO_TRUST_PROXY=true` to correctly identify client IPs.
- Enabled strict `noExplicitAny` linting rule in biome.json (changed from warn to error).
- Standardized `@sinclair/typebox` dependency to `^0.34.0` across all packages.
- Updated GitHub Actions pins to current Node 24-compatible releases and replaced the deprecated cache action in shared CI/release setup.
- Refreshed direct runtime dependencies including `glob`, `otplib`, `@google/genai`, and `better-sqlite3`.

### Deprecated

The following APIs are deprecated and will be removed in a future release:

**Agent API:**
- `Agent.setQueueMode()` → Use `setSteeringMode()`/`setFollowUpMode()` instead
- `Agent.queueMessage()` → Use `steer()`/`followUp()` instead
- `AgentState.queueMode` → Use `steeringMode`/`followUpMode` instead
- `AgentOptions.getQueuedMessages` → Use `getSteeringMessages()`/`getFollowUpMessages()` instead

**Skills API:**
- `SkillFrontmatter.tags` → Use `metadata` instead
- `SkillFrontmatter.author` → Use `metadata.author` instead
- `SkillFrontmatter.version` → Use `metadata.version` instead
- `SkillFrontmatter.triggers` → Use `description` for trigger keywords instead
- `getSkillsSummary()` → Use `skillsToPrompt()` for XML format

**Modal API:**
- `Modal.onClose` → Use `dispose()` instead
- `Modal.onMount` → Use `mount()` instead
- `Modal.onUnmount` → Use `unmount()` instead

**Utilities:**
- `ConcurrencySlots` → Use `ConcurrencyManager` from `src/utils/concurrency-manager.ts`

### Fixed

- Added error handling for middleware chain execution to prevent unhandled promise rejections from crashing the server.
- Fixed `requestContextStorage.run()` not being awaited, which could cause unhandled promise rejections.
- Improved X-Forwarded-For parsing to read from right-to-left, preventing IP spoofing attacks.
- Added IPv6 normalization for consistent rate limiting (strips `::ffff:` prefix from IPv4-mapped addresses).
- Added validation for empty X-Forwarded-For headers to prevent grouping under empty string.
- Treat `tree-sitter` and `tree-sitter-bash` as optional install-time dependencies so Linux/Node 24 users can install Maestro even when native parser bindings are unavailable.
- Migrated TOTP generation and verification to `otplib` v13 while preserving Maestro's existing 6-digit, 30-second, one-step drift behavior.
- Rebundled Google provider runtime dependencies into the built CLI/provider artifacts and removed the unused root `better-sqlite3` dependency to keep installs quieter and the published runtime surface tighter.

## 0.10.0 – 2025-11-18

### Added

- Browser-based Web UI with full Maestro core integration, live event streaming, industrial instrument panel theme, and comprehensive settings panel.
- Dedicated `@evalops/tui` package, concurrently-powered dev flows, and a shared tool loop/renderer architecture that can drive both the TUI and the Web UI.
- Expanded slash-command surface area including `/plan`, `/cost`, `/config`, `/telemetry`, `/about`, `/report`, `/share`, `/compact`, `/ollama`, `/update`, and `/exec`, plus richer diagnostics/export tooling.
- GitHub CLI tool suite (`gh_pr`, `gh_issue`, `gh_repo`) with advanced filtering, diff previews, and review helpers, along with Exa-powered `websearch`, `codesearch`, and `webfetch` tools.
- Comprehensive model registry (300+ entries), Google Gemini provider support, CLAUDE OAuth, enhanced provider metadata, and improved telemetry/reporting experiences.

### Changed

- Rebranded the project from "Maestro CLI" to simply "Maestro", updated documentation (README, Quickstart, Feature Guide, Contributing) and installation instructions, and aligned repo/package names.
- Extracted TUI components into modular views, introduced a refined loader/welcome animation system, and improved bash-mode UX with history, multiline paste, and autocomplete.
- Migrated tools to the new DSL, hardened the agent transport/event pipeline, and refactored exporter infrastructure, session compaction, and diagnostics rendering.
- Overhauled build/test workflows: explicit workspace builds, Bun/NPM alignment, chunked evals across OS matrices, ripgrep installation, and safer CI release gating.

### Fixed

- Stabilized cost-tracker tests (time range filter, cache accounting), resolved session hydration/state issues, and ensured timestamps render in ISO format across UIs.
- Hardened LSP bootstrap/root detection, nix builds, and workspace dependency ordering; reduced test flake by disabling problematic parallelism and organizing imports.
- Updated eval scenarios (including README first-line regex) to reflect the rename, expanded telemetry coverage, and eliminated Anthropic transport duplication bugs.

## 0.9.0 – 2025-01-15

- Baseline release with Maestro CLI/TUI, eval suite, and provider registry
- Added telemetry report tooling and mock-agent integration tests

Older history lives in the Git commit log.
