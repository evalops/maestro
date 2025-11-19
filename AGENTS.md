# Agent Configuration

This document describes Composer's AI agent behavior, system prompts, and operational guidelines.

## Repo Development Tips

## Repo Development Tips

- Use `npx nx show projects` to see every workspace target instead of scanning directories manually.
- Jump straight into a package with `npx nx graph --focus <project>` or `npx nx run <project>:build --skip-nx-cache` to verify the wiring.
- Install only what you need by running `bun install` at the root (workspace-aware) or `bun install --filter <package>` inside a package for targeted debugging.
- Scaffold new packages with `bun create vite <package> -- --template react-ts` and update the package `name` field plus `project.json` entry so Nx picks it up.
- After moving files or changing imports, re-run `bunx biome check .` and `npx nx graph` to ensure Nx still resolves project boundaries.

## Testing Instructions

- Consult `.github/workflows` (notably `evals.yml`, `nx-ci.yml`, and `release.yml`) to mirror whatever CI will execute.
- Root test + build entry point: `npx nx run composer:test --skip-nx-cache` (automatically builds `tui` and `composer-web`).
- Package-specific commands:
  - TUI: `bun run --filter @evalops/tui build` or `npx nx run tui:build`.
  - Web: `bun run --filter @evalops/composer-web build` or `npx nx run composer-web:build`.
  - Root lint: `bun run bun:lint` (runs Biome + eval verifier) and `npx nx run composer:lint` if you need the Nx target explicitly.
- Use Vitest filters for targeted cases: `bunx vitest --run -t "<test name>"`.
- Never merge without the full lint + test suite passing locally; match CI by running `bun run bun:lint && npx nx run composer:test --skip-nx-cache` before pushing.

## Pull Request Requirements

- Title format: `[composer] <short description>`.
- Branch off `main`; never commit directly to `main` (protected by rules anyway).
- Before opening a PR, run at minimum:
  - `bun run bun:lint`
  - `npx nx run composer:test --skip-nx-cache`
  - Any touched package builds (e.g., `npx nx run tui:build`).
- Include notes in the PR body if you have to skip a validator (e.g., `[skip ci]` or `[skip nix]`) and explain why.

## Core Principles

### 1. Explicit Over Implicit
Every action routes through explicit commands (`/run`, `/config`, etc.) so actions stay reviewable and scriptable. The agent never performs hidden operations or silent retries.

### 2. Deterministic Tooling
Composer touches the filesystem only via transparent git-aware helpers, keeping review diffs clean. All operations are logged and traceable.

### 3. Provider Agnostic
Multi-model switching and shared context loading ensure prompts stay portable between Anthropic, OpenAI, Gemini, Groq, and more.

### 4. Security First
By default, Composer runs with full trust (YOLO mode) - no prompts for permission, no command filtering. Users should run inside a VM/container if guardrails are needed.

## System Prompts

### Base System Prompt

Composer loads context from `AGENT.md` or `CLAUDE.md` files in this priority order:

1. **Global** (`~/.composer/agent/AGENT.md`) – Personal defaults
2. **Parent directories** – Walks up the tree, applying each file
3. **Project root** – Most specific context wins

#### Recommended AGENT.md Structure

```markdown
# Project Context

## Tech Stack
- Framework: [e.g., React, Vue, Express]
- Language: [e.g., TypeScript, Python]
- Build Tool: [e.g., Vite, Webpack]

## Coding Standards
- Use functional components with hooks
- Prefer async/await over callbacks
- Always include error handling
- Follow ESLint configuration

## Project Structure
\`\`\`
src/
  components/  # React components
  utils/       # Utility functions
  api/         # API client code
  types/       # TypeScript definitions
\`\`\`

## Testing Requirements
- Write unit tests for all utility functions
- Integration tests for API clients
- Use Vitest as test runner

## Common Commands
- Start dev server: \`npm run dev\`
- Run tests: \`npm test\`
- Build: \`npm run build\`
- Lint: \`npm run lint\`

## Special Instructions
- Never commit directly to main branch
- Always create feature branches
- Run tests before committing
```

### Tool Usage Guidelines

#### File Operations
- **read**: Read file contents (text + images). Supports offset/limit for large files.
- **write**: Write/overwrite files, creating parent directories as needed.
- **edit**: Replace exact text in a file (fails if multiple matches).
- **list**: List directory contents with glob filtering.
- **search**: Ripgrep-backed search with regex and context.

#### Git Operations
- **diff**: Inspect git diffs (working tree, staged index, revision ranges).
- Always run `git status` before other git operations.
- Never use interactive flags (-i).
- Check changes with `git diff` before committing.

#### Bash Execution
- **bash**: Execute shell commands with optional timeouts.
- Prefer absolute paths over changing directories.
- Quote paths with spaces or special characters.
- Chain commands with `&&` for dependencies.

#### Web & Search
- **websearch**: Search the web via Exa AI (requires `EXA_API_KEY`).
- **codesearch**: Search GitHub/docs/Stack Overflow (requires `EXA_API_KEY`).
- **webfetch**: Fetch content from specific URLs (requires `EXA_API_KEY`).

#### GitHub CLI Tools
- **gh_pr**: Pull request operations (create, checkout, view, list, comment).
- **gh_issue**: Issue operations (create, view, list, comment, close).
- **gh_repo**: Repository operations (view, fork, clone).
- Requires `gh` CLI installed and authenticated.

#### Task Management
- **todo**: Manage checklists stored in `~/.composer/todos.json`.

#### Batch Operations
- **batch**: Execute multiple independent tools in parallel (1-10 tools).
- Only batch read-only actions (`view`, `list`).
- Never batch mutations as order and outcome matter.

## Agent Capabilities

### Context Management

Composer automatically loads context files when starting new sessions:

1. Walks up directory tree from CWD
2. Loads `AGENT.md` or `CLAUDE.md` from each level
3. Applies context in order (global → parent → project)

Use context files for:
- Coding conventions
- Architecture notes
- Common commands
- Testing instructions
- Project-specific guidelines

### Session Management

Sessions are stored as JSONL in `~/.composer/agent/sessions/`:

- `composer --continue` or `-c`: Resume latest session
- `composer --resume` or `-r`: Interactive session selector
- `composer --no-session`: Ephemeral run
- `composer --session /path/file.jsonl`: Resume specific session

Each message appends to the file. Use `/export` to save as standalone HTML before archiving.

### Image Support

Pass image paths directly in prompts. Composer encodes these formats:
- `.jpg`, `.jpeg`
- `.png`
- `.gif`
- `.webp`

Works with vision-capable models.

## Safety & Approvals

### Action Firewall

Located in `src/safety/action-firewall.ts`, the firewall validates:
- Path traversal prevention
- File size limits
- Command injection prevention
- Dangerous command patterns

### Safe Mode

Enable via `COMPOSER_SAFE_MODE=1`. When active:
- Prompts before destructive operations
- Validates all file paths
- Blocks dangerous shell commands
- Logs all actions

### Approval System

The TUI includes an approval modal for high-risk operations:
- File deletions
- Git force operations
- System-level commands

## Error Handling

### Tool Failures

Failed tools are logged to `~/.composer/tool-failures.log`. View with `/tools` command.

Common failure patterns:
- **FileNotFound**: Path doesn't exist
- **PermissionDenied**: Insufficient access rights
- **Timeout**: Command exceeded time limit
- **ValidationError**: Invalid arguments or schema mismatch

### Recovery Strategies

1. **Partial JSON**: Uses `partial-json` library for streaming responses
2. **Retry Logic**: Automatic retries with exponential backoff for network errors
3. **Graceful Degradation**: Falls back to simpler operations when advanced features fail

### Debug Mode

Enable verbose logging:

```bash
export COMPOSER_LOG_LEVEL=debug
export COMPOSER_LOG_JSON=1  # JSON format for log aggregation
```

## Best Practices

### 1. Write Clear Instructions

❌ Bad:
```
Make this better
```

✅ Good:
```
Refactor the authentication module in src/auth/ to:
1. Use async/await instead of callbacks
2. Add proper error handling with try/catch
3. Include JSDoc comments for all exported functions
4. Write unit tests using Vitest
```

### 2. Provide Context

Include relevant information in your prompt or `AGENT.md`:
- Current architecture
- Related files
- Constraints or requirements
- Expected behavior

### 3. Review Before Committing

Always review Composer's changes:
```bash
composer "Add user authentication"
git diff  # Review changes
git add -p  # Stage selectively
git commit -m "Add authentication module"
```

### 4. Use Sessions Wisely

- Continue sessions for related work
- Start fresh for unrelated tasks
- Export important sessions for reference

### 5. Leverage Tools

Don't ask Composer to:
- Search files manually (use `/search` or `search` tool)
- List directories manually (use `/list` or `list` tool)
- Read multiple files sequentially (use `batch` tool)

## Troubleshooting

### Common Issues

#### Authentication Errors

```bash
# Verify API key is set
echo $ANTHROPIC_API_KEY

# Check provider configuration
composer --diag
```

#### Session Corruption

```bash
# List sessions
ls ~/.composer/agent/sessions/

# Delete corrupted session
rm ~/.composer/agent/sessions/session-xxx.jsonl

# Or start fresh
composer --no-session
```

#### Tool Failures

```bash
# View recent failures
composer
/tools

# Clear failure log
/tools clear
```

#### LSP Issues

```bash
# Check LSP configuration
cat ~/.composer/lsp-config.json

# Restart LSP server
composer
# (LSP restarts automatically on model switch)
```

## Contributing

When modifying agent behavior:

1. Update this document
2. Add tests for new functionality
3. Run `npm run verify` before committing
4. Update `CHANGELOG.md`

