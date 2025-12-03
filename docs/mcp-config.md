# MCP configuration refresh (Composer)

This document captures the refreshed MCP configuration approach for Composer. It is inspired by other agents but re‑implemented from scratch for our stack.

## Goals
- Accept both array and `mcpServers` object formats.
- Support multiple scopes with clear precedence.
- Expand `${VAR}` and `${VAR:-fallback}` in commands/URLs/headers/env.
- Detect transports (stdio/http/sse) predictably.
- Keep disabled servers out of the resolved set.
- Provide helper utilities for MCP tool naming (`mcp__<server>__<tool>`).
- Lay groundwork for environment limit validators (token/output caps) without hard‑wiring policy yet.

## Scopes and precedence
Highest precedence wins on the same server name:
1. Enterprise: `~/.composer/enterprise/mcp.json` (optional)
2. Plugin/Dynamic: supplied programmatically when available
3. Project: `<project>/.composer/mcp.json`
4. Local (private overrides): `<project>/.composer/mcp.local.json`
5. User: `~/.composer/mcp.json`

## Transport detection
- Explicit `transport` respected when valid.
- If a `url` is present and `transport` is not set:
  - `sse` when the URL ends with `/sse`, contains `/sse/`, or has an `sse.` subdomain.
  - Otherwise `http`.
- If no URL, default to `stdio`.

## Server validation (new zod schema)
- `name`: required, `/^[a-zA-Z0-9_-]+$/`
- `transport`: `stdio | http | sse`
- stdio requires `command`; http/sse require `url`.
- Optional: `args`, `env`, `cwd`, `headers`, `timeout`, `enabled`/`disabled`.

## Env expansion
- Supports `${VAR}` and `${VAR:-fallback}` across `command`, `args`, `url`, `headers`, and `env` values.
- Missing vars are collected and logged at debug level; they do not crash config loading.

## Tool naming helpers
- Prefix: `mcp__<server>__<tool>`
- Strip/present helpers to show user‑friendly names while preserving uniqueness.

## Env limit validator pattern
- Lightweight validators return `{ effective, status, message? }`.
- Pattern stubbed for future use (e.g., output token caps).

## Compatibility
- Existing tests for mcp loader formats remain supported.
- Project/user paths stay the same; new enterprise/local scopes are additive and safe to ignore when absent.
