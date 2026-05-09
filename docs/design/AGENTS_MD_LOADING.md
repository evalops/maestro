# AGENTS.md Loading

Maestro loads project instructions from global user context first, then from the
current workspace path from least-specific to most-specific directory. This lets
a monorepo define broad root guidance and refine it inside individual packages.

## Search Order

For each instruction directory, Maestro reads the first matching file from this
candidate list:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. `Agents.md`
4. `agents.md`
5. `AGENT.md`
6. `Agent.md`
7. `agent.md`
8. `CLAUDE.md`

`CLAUDE.md` remains a compatibility fallback when no AGENTS/AGENT file exists
in that directory.

## Directories

Maestro searches:

1. The configured Maestro agent directory, normally `~/.maestro/agent`.
2. The user-global config directory, `~/.config`.
3. Each parent directory from filesystem root down to the current working
   directory.

Only one instruction file is loaded per directory. If both `AGENTS.md` and
`CLAUDE.md` exist in the same directory, `AGENTS.md` wins.

## Prompt Format

Each loaded file is inserted into the system prompt with an explicit directory
header and XML instruction wrapper:

```md
# AGENTS.md instructions for /repo/packages/api

<INSTRUCTIONS>
Use pnpm for this package.
</INSTRUCTIONS>
```

The wrapper keeps project-authored guidance separate from surrounding system
prompt text and makes hierarchical instruction boundaries visible to the model.

