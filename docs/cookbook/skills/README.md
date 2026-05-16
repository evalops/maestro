# Skill Cookbook

## Minimal Skill

```bash
maestro skill new reviewing-prs --description "Review pull requests. Use when the user asks for PR review."
maestro skill lint .maestro/skills/reviewing-prs
```

The generated package includes:

```text
reviewing-prs/
  SKILL.md
  reference/overview.md
  scripts/README.md
  toolbox/README.md
  mcp.json.example
```

## Bundled MCP Server

Copy `mcp.json.example` to `mcp.json` and keep the exposed tools filtered:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "includeTools": ["get_pull_request", "list_pull_request_files"]
  }
}
```

`maestro skill lint` fails packages that omit `includeTools`.

## Reference Files

Put long examples and troubleshooting notes under `reference/`. Keep `SKILL.md`
short enough for the agent to load quickly; references are Level 3 context and
should be read only when the task needs them.

## Toolbox Executables

Put executable tool commands under `toolbox/`. A toolbox command should describe
itself when `MAESTRO_TOOLBOX_ACTION=describe` is set:

```bash
MAESTRO_TOOLBOX_ACTION=describe .maestro/skills/reviewing-prs/toolbox/list-pr-files
```

Run strict validation with:

```bash
maestro skill lint .maestro/skills/reviewing-prs --describe-toolbox
```

## Model And Mode Hints

Skills can declare model and mode preferences:

```yaml
model: gpt-5.5
mode: review
isolatedContext: true
```

These fields are advisory until the runtime can enforce skill-scoped dispatch.
