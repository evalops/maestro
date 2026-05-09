# Agent File Citations

Agent-authored responses should make file references clickable across Maestro
surfaces. When an agent mentions a workspace file in user-facing text, it must
link the displayed path with a Markdown `file:///` URI.

## Format

```md
[<displayed-path-or-basename>](file:///<workspace-rooted-or-absolute-path>)
```

Examples:

```md
[src/auth/middleware.ts](file:///workspace/src/auth/middleware.ts)
[My Project/test file.js](file:///Users/alice/My%20Project/test%20file.js)
[src/auth/middleware.ts](file:///workspace/src/auth/middleware.ts#L42)
[src/auth/middleware.ts](file:///workspace/src/auth/middleware.ts#L42-L48)
[src/auth/middleware.ts](file:///workspace/src/auth/middleware.ts#L42C8)
```

## Rules

- Display the path or basename users should read, not the raw URI.
- Use `file:///` for local workspace files.
- Prefer workspace-rooted paths when the file is inside the current workspace.
- Use absolute paths when a file is outside the current workspace.
- Percent-encode spaces and other URI characters in link targets.
- Include line or column fragments when the agent knows the location.
- Use GitHub blob URLs at GitHub-comment boundaries instead of `file:///`.

## Prompt Rule

Every Maestro system-prompt path includes the file-citation rule via
`buildFileCitationPromptFragment()` in `src/cli/system-prompt.ts`. Keep the
prompt fragment short enough to appear in every agent mode and custom-prompt
flow.

Good:

```md
See [src/auth/middleware.ts](file:///workspace/src/auth/middleware.ts#L42) for the validation logic.
```

Bad:

```md
See src/auth/middleware.ts for the validation logic.
```

## Surface Expectations

The agent emits one canonical Markdown shape. Rendering surfaces are responsible
for adapting it:

- TUI: render as a terminal hyperlink when OSC 8 is available, otherwise show
  text plus the visible URI.
- Web: open the workspace file through the web/editor file-open handler.
- VS Code and JetBrains: open the file at the cited line or column.
- Slack: preserve Markdown so the link remains visible and clickable.
- GitHub agent: translate local file URIs to repository blob URLs before posting.

