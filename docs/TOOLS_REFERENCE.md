# Tools Reference

Audience: contributors and advanced users adding/debugging tools.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Features](FEATURES.md) · [Safety](SAFETY.md)

Contents: [Validation](#parameter-validation) · [Error Handling](#error-handling-for-tool-authors) · [Built-in Tools](#built-in-tools) · [GitHub CLI Tools](#github-cli-tools) · [SDK Tool Types](#sdk-tool-types) · [CLI Commands](#cli-commands) · [Common Errors](#common-errors--remedies)

The agent and CLI expose a consistent set of tools. Use this sheet when adding
new tools or debugging existing ones.

## Parameter Validation

Every tool declares a TypeBox schema, so arguments coming from the LLM (or
slash commands) are validated before execution. Defaults (e.g., `write.backup`,
`read.limit`) are applied automatically, and invalid combinations (such as
`search.context` alongside `beforeContext`/`afterContext`) are rejected with a
clear error message in chat.

Type definitions for tool payloads live in `packages/contracts/README.md`.

## Error Handling for Tool Authors

When implementing tools using the `createTool` DSL, use `respond.error()` to signal failures:

```typescript
export const myTool = createTool({
  name: "my-tool",
  schema: mySchema,
  async run(params, { respond }) {
    try {
      // Tool logic here
      const result = await doSomething(params);
      return respond.text(result);
    } catch (error) {
      // Use respond.error() - it throws a ToolError
      return respond.error("Operation failed", { 
        code: 500,
        // Sensitive paths like absolutePath, fullPath, realPath are sanitized
        context: "additional info"
      });
    }
  }
});
```

**Key Points:**
- `respond.error(message, details?)` throws a `ToolError` exception
- The transport layer catches it and sets `isError: true` on the result
- Error details are automatically sanitized to remove sensitive paths (`absolutePath`, `fullPath`, `realPath`)
- Agents can distinguish between successful tool calls and errors for proper retry logic
- Never return error text as successful content - always use `respond.error()`

## Built-in Tools

| Tool | Description | Key Options / Notes |
| ---- | ----------- | ------------------- |
| `background_tasks` | Runs commands in the background and manages lifecycle. | `action` one of `start | list | stop | logs`; `start` supports `cwd`, `env`, `shell`, `restart` (maxAttempts, delayMs, strategy, maxDelayMs, jitterRatio), and `limits` (maxTasks, maxRssKb, maxCpuMs, logSizeLimit, logSegments, retentionMs). Logs are tailed via `action=logs`. TUI notifications/history detail depend on `~/.composer/agent/background-settings.json` (or `COMPOSER_BACKGROUND_SETTINGS`) flags `notificationsEnabled` and `statusDetailsEnabled`; manual edits are hot-reloaded and summaries are secret-redacted. |
| `read` | Reads file contents with syntax-aware chunking. Supports text, images, PDFs, and Jupyter notebooks. | Accepts `path`, optional `startLine`/`endLine`. Images are optimized with Sharp if available. PDFs are extracted to text. Notebooks display formatted cells with outputs. |
| `list` | Lists files in a directory (non-recursive by default). | Supports glob filters and depth. Used for context discovery. |
| `search` | Ripgrep-style text search. | Args mirror `rg` (`pattern`, `path`, `glob`). Output includes file:line matches. Default max results now capped to avoid huge responses; oversized outputs are truncated and marked. |
| `diff` | Wrapper around `git diff`. | Modes: workspace, staged, or custom ranges. Also supports `mode: "status"` (legacy) but prefer the dedicated `status` tool. |
| `status` | Structured `git status` (porcelain v2). | Options: `branchSummary` (-b), `includeIgnored` (`--ignored=matching`), `paths`. Returns parsed status in details + summary text. |
| `bash` | Executes shell commands (`bash -lc`). | Default timeout 90s (max 600s) and 40KB output cap; mutating commands require a plan when safe-mode is on. Runs from repo root; stdout/stderr streamed. In bash mode, `cd` is handled internally. |
| `edit` | Structured find/replace writer. | Accepts `path`, `oldText`, `newText`. Supports `edits` array for multiple sequential edits, `replaceAll` for bulk replacements, and `dryRun` for previews. |
| `write` | Writes or overwrites files. | Takes `path` + `contents`. Creates directories automatically. |
| `todo` | Generates TodoWrite-style task lists. | Stored near the project (`~/.composer/todos.json`). Integrates with `/plan`. |
| `notebook_edit` | Edit Jupyter notebook (.ipynb) files at the cell level. | Modes: `replace` (default), `insert`, `delete`. Identify cells by `cell_id` or `cell_index`. Specify `cell_type` (code/markdown) for inserts. |
| `ask_user` | Ask structured questions with predefined options. | 1-4 questions per call, each with 2-4 options. Supports `multiSelect` for non-exclusive choices. "Other" option auto-added. |
| `websearch` | Search the web via Exa AI for real-time information. | Supports neural/keyword search, domain filtering, date ranges. Requires `EXA_API_KEY` env var. Large result text is previewed with truncation and overall output is capped. |
| `codesearch` | Search GitHub/docs/Stack Overflow for code examples via Exa Code. | Returns working code snippets with context. Requires `EXA_API_KEY` env var. |
| `webfetch` | Fetch content from specific URLs via Exa. | Converts HTML to markdown, truncates very long content, and caps total output. Requires `EXA_API_KEY` env var. |

## GitHub CLI Tools

| Tool | Description | Actions / Options |
| ---- | ----------- | ----------------- |
| `gh_pr` | Pull request operations | **Actions:** `create`, `checkout`, `view`, `list`, `comment`<br>**Options:** `number`, `title`, `body`, `branch`, `base`, `draft`, `state`, `author`, `limit`, `json` |
| `gh_issue` | Issue operations | **Actions:** `create`, `view`, `list`, `comment`, `close`<br>**Options:** `number`, `title`, `body`, `labels`, `state`, `author`, `limit`, `json` |
| `gh_repo` | Repository operations | **Actions:** `view`, `fork`, `clone`<br>**Options:** `repository`, `directory`, `json` |

**Prerequisites:**
- GitHub CLI (`gh`) must be installed: `brew install gh` (macOS) or see [cli.github.com](https://cli.github.com)
- Must be authenticated: `gh auth login`
- Must be in a git repository with GitHub remote (for PR/issue operations)

**Batch Tool Usage:**
- Parallelism is native: emit multiple tool calls in one response when you need concurrent reads/searches; the runtime will execute independent calls in parallel without a batch wrapper.

**Examples:**
```javascript
// Create PR
{action: "create", title: "Fix auth bug", body: "Details...", base: "main"}

// Checkout PR for review
{action: "checkout", number: 123}

// Create issue with labels
{action: "create", title: "Bug report", body: "Steps...", labels: ["bug", "priority"]}

// List open issues by author
{action: "list", state: "open", author: "username", limit: 10}

// View repo info as JSON
{action: "view", json: true}
```

## SDK Tool Types

For external SDK consumers, tool input schemas are exported from `@evalops/composer`:

```typescript
import {
  ReadInputSchema,
  EditInputSchema,
  BashInputSchema,
  NotebookEditInputSchema,
  AskUserInputSchema,
  getToolSchema,
  type ReadInput,
  type EditInput,
} from '@evalops/composer';

// Get schema at runtime
const schema = getToolSchema('read');

// Type-safe tool parameters
const readParams: ReadInput = {
  path: '/path/to/file',
  offset: 1,
  limit: 100,
};
```

Available schemas: `ReadInputSchema`, `EditInputSchema`, `WriteInputSchema`, `BashInputSchema`, `SearchInputSchema`, `ListInputSchema`, `NotebookEditInputSchema`, `TodoInputSchema`, `AskUserInputSchema`, `WebSearchInputSchema`, `WebFetchInputSchema`, `AgentInputSchema`.

## CLI Commands

For install/build/test entrypoints, use `docs/QUICKSTART.md` (canonical). Key dev helpers: `bun run cli -- --help`, `npx nx run composer:evals --skip-nx-cache`, `bun run telemetry:report`.

## Common Errors & Remedies

- **File not found** (read/write/list/search): ensure the tool uses absolute
  paths resolved via `process.cwd()`; sanitize user input before reading.
- **Diff shows nothing**: workspace clean. Use `/diff staged` or ensure `git`
  knows about the changes.
- **Bash tool blocked**: action firewall flagged a destructive command. Approve
  via the TUI prompt or adjust the safe-mode settings.
- **Tool queue stuck**: `/queue cancel <id>` removes stale prompts; loader now
  uses a subtle animation so you know when the agent is still working.

If you add a tool, expose it in:

1. `src/tools/index.ts` (registration)
2. Docs (update this file + CLI help if needed)
3. Tests/evals if the behavior is user-facing
