# Maestro Documentation Index

Use this index to jump to the right guide quickly and see how the pieces connect.

## Start Here
- [Quickstart](QUICKSTART.md) — installation, environment prep, builds, and the fast path to running the CLI/TUI/Web.
- [Contributor Runbook](CONTRIBUTOR_RUNBOOK.md) — day-one flow for contributors (build, lint, verify).
- [Feature Guide](FEATURES.md) — user-facing capabilities across the TUI and CLI with power-user tips.
- [Web UI Guide](WEB_UI.md) — browser workflow and TUI/Web parity appendix.
- [Conductor Bridge](CONDUCTOR_BRIDGE.md) — connect the Conductor extension to a local Maestro server.
- [Ambient Agent Design](design/AMBIENT_AGENT.md) — always-on GitHub agent daemon architecture.

## Core Reference
- [Tools Reference](TOOLS_REFERENCE.md) — authoritative slash command and flag definitions.
- [Safety](SAFETY.md) — approvals, sandboxing, and firewall behavior.
- [Threat Model](THREAT_MODEL.md) — security architecture, trust boundaries, and attack mitigations.
- [Models](MODELS.md) — provider/model registry sources, overrides, defaults, and OpenAI-compat quirks.
- [Sessions](SESSIONS.md) — session formats, storage locations, and management commands.
- [Prompt Queue](PROMPT_QUEUE.md) — queue lifecycle, prioritization, and diagnostics hooks.
- [MCP Guide](MCP_GUIDE.md) — Model Context Protocol setup and usage.

## Architecture & Patterns
- [Architecture Diagram](ARCHITECTURE_DIAGRAM.md) — high-level system layout.
- [VS Code Architecture](VSCODE_ARCHITECTURE.md) — extension-specific architecture and flows.
- [Ambient Agent Design](design/AMBIENT_AGENT.md) — always-on GitHub agent daemon architecture.
- [Patterns](patterns/INDEX.md) — implementation patterns (e.g., event suppression, tool error handling).
- [Upstreams: pi-mono](upstreams/pi-mono.md) — notes on upstream inspirations/adaptations.

## Feature Design Docs
- [Design Index](design/INDEX.md) — comprehensive design documentation for all major subsystems.
  - Core Systems: Tool System, Agent State Machine, Context Management, Session Persistence
  - User Interface: TUI Rendering, Web UI Architecture
  - Safety & Security: Safety Firewall, Enterprise RBAC, OAuth Authentication
  - Supporting Systems: Hooks, MCP Integration, LSP Integration, Telemetry, Database

## Deployment & Operations
- [Enterprise](ENTERPRISE.md) — deployment, configuration, and hardening guidance for controlled environments.
- [CI Version Pins](CI_VERSION_PINS.md) — where Node/Bun/action SHAs are pinned and how to update them safely.
- [Open Code Parity](opencode-parity.md) — notes on parity with open code releases.
- [Changelog](../CHANGELOG.md) — release history and notable changes.

When in doubt, start with the Quickstart, skim the Feature Guide, keep the Tools Reference nearby, and use the Contributor Runbook before opening a PR.
