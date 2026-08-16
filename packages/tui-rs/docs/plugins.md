# Plugins Foundation

Maestro discovers **filesystem plugins** that package reusable agent
capabilities — skills, agents, slash-command templates, hooks, MCP configs,
and declarative connection types —
similar to Grok-style plugin packages.

Installed components are independently permissioned. Connection types are
metadata only; Maestro owns secret resolution, leases, and runtime injection.

## Layout

```text
<plugin-root>/
  plugin.json          # optional manifest
  skills/              # SKILL.md packages
  commands/            # markdown command templates
  hooks/hooks.json or hooks.toml
  .mcp.json or mcp.json
  connections.json     # declarative types; never secret values or resolver code
```

## Discovery order (high → low)

1. CLI/env override *(reserved for a later slice)*
2. `.maestro/plugins/*` (project)
3. `~/.maestro/plugins/*` (user)
4. Legacy: `.composer/plugins/*` and `~/.composer/plugins/*`

When two plugins share a name, the higher-priority origin wins (project over
user; Maestro over composer).

## `plugin.json`

All fields are optional. Missing paths fall back to conventions.

```json
{
  "name": "team-tools",
  "version": "0.1.0",
  "description": "Shared team skills and hooks",
  "skills": "skills",
  "commands": "commands",
  "hooks": "hooks/hooks.toml",
  "mcp": "mcp.json",
  "connections": "connections.json"
}
```

Without a manifest, Maestro looks for `skills/`, `commands/`,
`hooks/hooks.toml|hooks/hooks.json|hooks.toml|hooks.json`, and
`mcp.json|.mcp.json`, and `connections.json` under the plugin root.

## Slash command

| Command | Description |
| --- | --- |
| `/plugins` | List discovered plugins (name, origin, components, path) |
| `/plugins <name>` | Show details for one plugin |
| `/plugins reload` | Rediscover plugins and reload skills |

Alias: `/plugin`.

## Integration

- **Skills:** plugin `skills/` directories are added to `SkillLoader` at app
  startup and on `/skills reload` / `/plugins reload`. Loaded skills use
  `SkillSource::Plugin`.
- **Commands / hooks / MCP:** paths are exposed via
  `PluginRegistry::command_dirs()`, `hook_configs()`, and `mcp_paths()` for
  their native integrations.
- **Connections:** `connections.json` is loaded only after the independent
  `connections` plugin capability is enabled. New and legacy installs default
  this capability off. The strict schema cannot provide executable secret
  handlers. See [Managed Connections](../../../docs/design/MANAGED_CONNECTIONS.md).

## Example

```bash
mkdir -p .maestro/plugins/team-tools/skills/review-pr
cat > .maestro/plugins/team-tools/plugin.json <<'EOF'
{
  "name": "team-tools",
  "version": "0.1.0",
  "description": "Team review helpers",
  "skills": "skills"
}
EOF
cat > .maestro/plugins/team-tools/skills/review-pr/SKILL.md <<'EOF'
---
name: review-pr
description: Review a pull request with a consistent checklist
---
# PR Review

Follow the team checklist when reviewing PRs.
EOF
```

Then in the TUI:

```text
/plugins
/plugins team-tools
/skills
```
