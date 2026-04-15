# Maestro by EvalOps

[![CI](https://github.com/evalops/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/evalops/maestro/actions/workflows/ci.yml)

Maestro is a coding agent for real software work. It can inspect code, edit files, run shell commands, search large repos, and help across terminal, web, IDE, browser, Slack, and GitHub workflows.

This README is intentionally short. Use it to get running, then jump into the docs for the details.

## What Maestro Covers

- Terminal-first coding agent with both interactive TUI and one-shot CLI flows
- Shared runtime across the web UI, VS Code, JetBrains, browser automation, Slack, and GitHub
- Multi-provider model support, OAuth-based logins, and managed EvalOps routing
- Hooks, MCP servers, context files, and headless automation for custom workflows
- Visible tool use with approvals, sandboxing, and firewall controls

## Interfaces

| Interface | Best for | Guide |
| --- | --- | --- |
| Terminal (TUI/CLI) | Interactive coding sessions and one-shot repo tasks | [Features](docs/FEATURES.md) |
| Web UI | Browser-based Maestro sessions | [Web UI Guide](docs/WEB_UI.md) |
| Conductor | Browser automation through a local Maestro server | [Conductor Bridge](docs/CONDUCTOR_BRIDGE.md) |
| VS Code | Inline chat and IDE-native workflows | [VS Code extension](packages/vscode-extension/README.md) |
| JetBrains | IntelliJ, WebStorm, PyCharm, and related IDEs | [JetBrains plugin](packages/jetbrains-plugin/README.md) |
| Slack | Chat-driven agent workflows with sandboxing | [Slack agent](packages/slack-agent/README.md) |
| GitHub | Issue-driven automation and PR generation | [GitHub agent](packages/github-agent/README.md) |
| Ambient Agent | Long-running GitHub automation daemon | [Ambient Agent design](docs/design/AMBIENT_AGENT.md) |
| Headless | Embedding Maestro in CI, tools, and eval harnesses | [Headless protocol](docs/protocols/headless.md) |

## Install

### Bun (recommended)

```bash
bun install -g @evalops/maestro
```

### npm

```bash
npm install -g @evalops/maestro
```

### Nix

```bash
nix run github:evalops/maestro
```

## Quick Start

1. Configure a model provider. Fast path:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Maestro also supports OpenAI, Google, OpenRouter, Azure OpenAI, GitHub Copilot, Groq, xAI, Cerebras, and managed EvalOps auth. See [Models](docs/MODELS.md) for provider-specific setup and overrides.

2. Launch the interface you want:

```bash
maestro
maestro "Audit this repository and suggest the next refactor"
maestro web
```

`maestro web` starts the browser UI on `http://localhost:8080`.

3. Add project-specific behavior when needed:

- Keys and config: `~/.maestro/keys.json`, `~/.maestro/config.json`
- MCP servers: `~/.maestro/mcp.json` or `.maestro/mcp.json`
- Hooks: `~/.maestro/hooks.json` or `.maestro/hooks.json`
- Agent instructions: `AGENT.md`, `.maestro/APPEND_SYSTEM.md`, `~/.maestro/agent/AGENT.md`

## Safety Model

- Approval modes let you choose how much confirmation Maestro needs before acting
- Sandbox modes range from workspace containment to `danger-full-access`
- Firewall rules, trusted paths, and CI/secrets protections reduce common footguns

See [Safety](docs/SAFETY.md) and the [Threat Model](docs/THREAT_MODEL.md) for the full behavior.

## Docs

| Goal | Guide |
| --- | --- |
| Install, build, and first run | [Quickstart](docs/QUICKSTART.md) |
| Learn TUI and CLI workflows | [Features](docs/FEATURES.md) |
| Find slash commands and flags | [Tools Reference](docs/TOOLS_REFERENCE.md) |
| Configure providers and models | [Models](docs/MODELS.md) |
| Understand approvals and sandboxing | [Safety](docs/SAFETY.md) |
| Run the browser interface | [Web UI Guide](docs/WEB_UI.md) |
| Set up MCP servers | [MCP Guide](docs/MCP_GUIDE.md) |
| Work on the repo as a contributor | [Contributor Runbook](docs/CONTRIBUTOR_RUNBOOK.md) |
| Integrate Maestro headlessly | [Headless protocol](docs/protocols/headless.md) |
| Browse the full docs map | [Documentation index](docs/README.md) |

## Contributing

Fast path for local development:

```bash
git clone https://github.com/evalops/maestro.git
cd maestro
bun install
npx nx run maestro:build --skip-nx-cache
npx nx run maestro:test --skip-nx-cache
npx nx run maestro:evals --skip-nx-cache
```

Need Redis or PostgreSQL for a specific workflow? Start from `docker-compose.yml` and use the [Contributor Runbook](docs/CONTRIBUTOR_RUNBOOK.md) for the rest of the repo workflow.

## Repository Layout

- `src/` - CLI entrypoints and shared application code
- `packages/core/` - agent loop, transport, types, and sandbox primitives
- `packages/ai/` - model registry, provider transport, and event streaming
- `packages/tui/` - TypeScript terminal UI
- `packages/tui-rs/` - native Rust TUI
- `packages/web/` - browser UI
- `packages/vscode-extension/`, `packages/jetbrains-plugin/`, `packages/slack-agent/`, `packages/github-agent/` - interface integrations

## License

Business Source License 1.1. You can use Maestro for development, testing, and production use, but not as a competing hosted or embedded product. On April 14, 2030, the license converts to Apache 2.0. See [LICENSE](LICENSE) for details.
