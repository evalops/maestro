# Feature Design Documents

This directory contains detailed design documentation for each major feature and subsystem in Maestro. These documents provide deep technical insight into architecture decisions, data flows, and implementation patterns.

## Core Systems

| Document | Description |
|----------|-------------|
| [Agent State Machine](AGENT_STATE_MACHINE.md) | Event-driven LLM interaction engine and orchestration |
| [Tool System Architecture](TOOL_SYSTEM.md) | Tool DSL, execution lifecycle, caching, and validation |
| [Context Management](CONTEXT_MANAGEMENT.md) | Token budgeting, context sources, and auto-compaction |
| [Session Recovery & Persistence](SESSION_PERSISTENCE.md) | JSONL storage, buffered writing, and crash recovery |
| [Headless Control Plane](HEADLESS_CONTROL_PLANE.md) | Remote/session control-plane design for headless, replay, and client callbacks |
| [Run Timeline Contract](../protocols/run-timeline.md) | Product-safe run event projection, redaction, visibility, and stable IDs |

## User Interface

| Document | Description |
|----------|-------------|
| [TUI Rendering Engine](TUI_RENDERING.md) | Terminal UI architecture, differential rendering, and event handling |
| [Web UI Architecture](WEB_UI_ARCHITECTURE.md) | Browser-based interface, WebSocket communication, and state sync |

## Safety & Security

| Document | Description |
|----------|-------------|
| [Safety & Firewall System](SAFETY_FIREWALL.md) | Rule-based safety enforcement, dangerous command detection |
| [Platform ToolExecution Bridge](PLATFORM_TOOL_EXECUTION_BRIDGE.md) | Shared policy, approval, and audit bridge for Maestro tool calls |
| [Enterprise RBAC & Audit](ENTERPRISE_RBAC.md) | Role-based access control, audit logging, and multi-tenancy |

## Supporting Systems

| Document | Description |
|----------|-------------|
| [OAuth & Authentication](OAUTH_AUTHENTICATION.md) | Multi-provider OAuth, token management, and credentials |
| [Database & Persistence](DATABASE_PERSISTENCE.md) | Schema design, migrations, encryption, and distributed locks |
| [Hooks System](HOOKS_SYSTEM.md) | Lifecycle events, external integrations, and hook configuration |
| [MCP Protocol Integration](MCP_INTEGRATION.md) | Model Context Protocol, tool bridging, and server management |
| [LSP Integration](LSP_INTEGRATION.md) | Language Server Protocol for IDE features |
| [Telemetry & Cost Tracking](TELEMETRY_COST.md) | Usage tracking, cost calculation, and analytics |

## Autonomous Agents

| Document | Description |
|----------|-------------|
| [Ambient Agent](AMBIENT_AGENT.md) | Always-on GitHub agent daemon (Ambient Maestro) |

## How to Use These Documents

1. **New Contributors**: Start with [Agent State Machine](AGENT_STATE_MACHINE.md) to understand the core event flow
2. **Adding Features**: Review relevant feature docs before modifying subsystems
3. **Debugging**: Use flow diagrams to trace execution paths
4. **Architecture Decisions**: Each doc explains *why* decisions were made

## Document Structure

Each design document follows a consistent structure:

1. **Overview**: High-level purpose and responsibilities
2. **Architecture**: System diagrams and component relationships
3. **Data Flow**: Step-by-step execution sequences
4. **Key Interfaces**: Important types and contracts
5. **Configuration**: Customization options
6. **Error Handling**: Failure modes and recovery
7. **Performance**: Caching, optimization strategies
8. **Testing**: How to test the subsystem
