# Tools Reference

The agent and CLI expose a consistent set of tools. Use this sheet when adding
new tools or debugging existing ones.

## Parameter Validation

Every tool declares a TypeBox schema, so arguments coming from the LLM (or
slash commands) are validated before execution. Defaults (e.g., `write.backup`,
`read.limit`) are applied automatically, and invalid combinations (such as
`search.context` alongside `beforeContext`/`afterContext`) are rejected with a
clear error message in chat.

## Built-in Tools

| Tool | Description | Key Options / Notes |
| ---- | ----------- | ------------------- |
| `batch` | Executes multiple independent tools in parallel (1-10 tools). | Accepts `toolCalls` array. Disallows `batch`, `edit`, `write`. Ideal for parallel reads/searches/listings. |
| `read` | Reads file contents with syntax-aware chunking. | Accepts `path`, optional `startLine`/`endLine`. Errors with "File not found". |
| `list` | Lists files in a directory (non-recursive by default). | Supports glob filters and depth. Used for context discovery. |
| `search` | Ripgrep-style text search. | Args mirror `rg` (`pattern`, `path`, `glob`). Output includes file:line matches. |
| `diff` | Wrapper around `git diff`. | Modes: workspace, staged, or custom ranges. Highlights hunks for the agent. |
| `bash` | Executes shell commands (`bash -lc`). | Runs from repo root; stdout/stderr streamed. In bash mode, `cd` is handled internally. |
| `edit` | Structured find/replace writer. | Accepts `path`, `find`, `replace`. Ensures replacements align with expected text. |
| `write` | Writes or overwrites files. | Takes `path` + `contents`. Creates directories automatically. |
| `todo` | Generates TodoWrite-style task lists. | Stored near the project (`~/.composer/todos.json`). Integrates with `/plan`. |
| `websearch` | Search the web via Exa AI for real-time information. | Supports neural/keyword search, domain filtering, date ranges. Requires `EXA_API_KEY` env var. |
| `codesearch` | Search GitHub/docs/Stack Overflow for code examples via Exa Code. | Returns working code snippets with context. Requires `EXA_API_KEY` env var. |
| `webfetch` | Fetch content from specific URLs via Exa. | Converts HTML to markdown. Requires `EXA_API_KEY` env var. |

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
- ✅ Safe for batch: `view`, `list` actions (read-only operations)
- ❌ Do NOT batch: `create`, `comment`, `close`, `checkout` actions (mutations where order/outcome matters)

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

## CLI Commands

| Command | Purpose |
| ------- | ------- |
| `npm run cli -- --help` | Display CLI/TUI usage. |
| `npm run evals` | Run regression scenarios (helps when editing help text or tools). |
| `npm run telemetry:report` | Summarize tool/agent telemetry logs. |

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
