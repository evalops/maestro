# Deixic Code

Deixic Code is Deixic's native Rust coding agent. One native runtime owns the
CLI, interactive terminal UI, headless protocol, hosted runner, and web runtime
gateway. Node.js and Bun are not required to run the product. Existing
`maestro` protocols and machine coordinates remain supported compatibility
identifiers.

## Specialists

Run a focused agent with `deixic-code exec --specialist product 'Review this journey'`.
Security, product, and performance focuses share the existing custom agent-profile
system. Use `deixic-code specialists list` to discover them. See
[Specialists](docs/specialists.md) for custom definitions, native delegation,
and explicit tool and sandbox limits.

## Thinking levels

Press **Shift+Tab** in the chat composer to cycle thinking effort. The cycle
uses the current model's effective levels; models without reasoning remain
Off. Draft text is preserved, and changes made during a response apply when
the runtime processes the setting before a subsequent model request. The
selected level appears in the footer and is recorded in the session.
Use `/thinking high` to choose a level directly. Plan and approval modes remain
available through their explicit commands (`/plan`, `/approvals`).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | bash
deixic-code --version
```

Opt into a preview channel when you want builds ahead of stable. Alpha tracks
the newest source; beta is deliberately one source commit and one patch line
behind alpha:

```sh
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | MAESTRO_INSTALL_CHANNEL=beta bash
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh | MAESTRO_INSTALL_CHANNEL=alpha bash
npm install -g @evalops/maestro@beta
npm install -g @evalops/maestro@alpha
```

The public repository and `@evalops/maestro` package remain supported
compatibility coordinates during the publication migration. Both install the
canonical `deixic-code` command and the retained `maestro` alias. See the
[compatibility matrix](docs/DEIXIC_CODE_MIGRATION.md).

The installer verifies the release checksum manifest and Cosign signatures when the release provides them, stages binaries and web assets under a versioned data directory, and swaps only the launcher. Set `MAESTRO_REQUIRE_SIGNED_INSTALL=1` to refuse legacy releases without signed metadata.

Installed interactive sessions check for updates on startup and apply newer releases before opening the TUI. The check is bounded and failures never block startup. Set `MAESTRO_AUTO_UPDATE=0` to opt out, `MAESTRO_AUTO_UPDATE=check` to show availability without installing, or use `deixic-code update --check` for an explicit check. Use `deixic-code update --channel beta` or `deixic-code update --channel alpha` for a one-time channel update; channel installers persist that choice for startup checks. Signed-release installs require Cosign verification during automatic updates; global npm and Bun installs update through their original package manager.

Release assets retain the compatibility names `maestro-darwin-arm64`,
`maestro-darwin-x64`, `maestro-linux-arm64`, and `maestro-linux-x64`. The npm
package contains the same native binaries and POSIX launchers; it does not
execute JavaScript at runtime.

## Use

```sh
deixic-code                         # interactive TUI
deixic-code setup                   # check auth/config and show the next setup step
deixic-code "fix the failing test" # interactive with an initial prompt
deixic-code exec "summarize this repository"
deixic-code --headless              # NDJSON protocol over stdio
deixic-code web --port 3000         # browser UI and HTTP runtime gateway
deixic-code hosted-runner
```

Sign in with `deixic-code evalops login` before starting a model turn.
The default model is GLM-5.3 through Deixic's LLM gateway. Your organization
must have model access enabled; signing in alone does not grant paid inference.
Provider credentials stay in the gateway. Explicit model settings and
`--model` continue to select another model, and using your own provider key
still requires Deixic login.

## Develop

Rust owns every agent/runtime path:

- `packages/maestro-rs`: compatibility-named executable and canonical command dispatch
- `packages/tui-rs`: agent core, providers, tools, TUI, and headless runtime
- `packages/runtime-gateway-rs`: HTTP/SSE/WebSocket runtime gateway

The repository contains no TypeScript source or TypeScript build toolchain. The browser UI is a versioned static asset snapshot served by the Rust runtime gateway; agent execution, protocols, adapters, CLI, and TUI are Rust.

```sh
cargo test --workspace --locked
npm run check:rust-only-runtime
```

See [Architecture](docs/ARCHITECTURE.md), [Quickstart](docs/QUICKSTART.md), and [Web UI](docs/WEB_UI.md).

Use the [terminal screenshot framework](docs/tui-screenshots.md) to capture the
native UI with local fixtures, custom dimensions, and verifiable PNG bundles.

The terminal is titled **Dex Code**; its little companion is Dex.

### Make Dex yours

Use `/dex appearance` to choose glasses, a beanie, an antenna, a sprout, cat ears,
a tiny crown, a bow, or an accent color.
Arrow keys select an option; Enter saves it across sessions. Click Dex or run
`/dex pet` for a brief reaction and a small rotating greeting. `/dex quiet` hides
the character, and `/dex motion-off` keeps it still. Cosmetic choices never change the model or
its permissions.

Dex's props follow recorded tool activity. Expressive mode adds a short phrase
alongside the actual activity label. `/dex tips-off` hides the startup hints;
choosing an appearance also marks that hint as learned.

After a completed turn, a suggested next prompt may appear in the empty composer.
Right arrow or Tab copies it into the editor; Enter is still required to send it.
Typing or Escape dismisses it. `/dex next` also fills the suggestion, and
`/dex suggestions-off` disables automatic suggestions.

`/dex recap` summarizes the latest observed turn. After three minutes away, a
short welcome-back recap appears if work finished or needed attention. Disable
it with `/dex recap-off`. Recaps do not infer test or PR status from tool output.

`/dex notifications-on` enables desktop attention notices while the terminal is
unfocused; `/dex notifications-off` disables them. The terminal must report focus
events. macOS uses `osascript`, Linux uses `notify-send`, and Windows uses native
PowerShell toast notifications. Desktop notification permissions and a supported
notification service are required. Command failures are logged without blocking
work. Notices contain fixed event descriptions, never transcript or file contents.

### Building native interactions

Use [`maestro-interaction`](packages/interaction-rs/README.md) for reusable event-driven attention, typed actions, selection, bounded reactions, and draft suggestions. Compose its state with `maestro-ui` widgets; the application retains runtime authority, preference persistence, and notification delivery. Dex and the theme selector are working consumers, and `cargo run -p maestro-interaction --example task_monitor` shows deterministic event replay without a terminal.
