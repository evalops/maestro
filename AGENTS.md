# Agent Configuration & Developer Protocol

This document defines the operational parameters for **Composer**. It serves two purposes:

1.  **Developer Guide:** Instructions for humans (and agents) modifying the Composer repository.
2.  **System Architecture:** Documentation of Composer's internal behavior, prompts, and tool capabilities.

-----

## 1\. Repository Development Protocol

**Context:** This repository uses a **Bun + Nx** monorepo structure. Strict adherence to the build pipeline is required.

**On first user message (do this in order):**
- Read the root `README.md` fully.
- Ask which package(s) to work on.
- Read the chosen package README(s) fully: `packages/ai/README.md`, `packages/tui/README.md`, `packages/agent/README.md`, `packages/coding-agent/README.md`, `packages/pods/README.md`, `packages/web-ui/README.md`.

### 🛠 Workspace Management

| Action | Command | Context |
| :--- | :--- | :--- |
| **List Projects** | `npx nx show projects` | View all workspace targets (avoids manual scan). |
| **Visualize** | `npx nx graph --focus <project>` | Verify wiring and dependencies. |
| **Install Root** | `bun install` | Workspace-aware installation. |
| **Install Pkg** | `bun install --filter <package>` | Targeted debugging inside a package. |
| **Check Deps** | `bunx biome check .` | Run after moving files/changing imports. |
| **Type Safety** | n/a | Avoid `any`; locate or define proper types (check `node_modules`) before falling back. |

### Build & Test Workflows

**Critical:** Consult `.github/workflows/` (`evals.yml`, `nx-ci.yml`, `release.yml`) to mirror CI environments.

#### Root Commands

  * **Full Test Suite:** `npx nx run composer:test --skip-nx-cache` (Builds `tui` + `composer-web` automatically). Run after every code change.
  * **Linting:** `bun run bun:lint` (Biome + Eval Verifier). Run after every code change.
  * **Runtime Commands:** Avoid long-lived `dev`/watch servers (e.g., `npm run dev`) unless the user explicitly requests them.

#### Package-Specific Commands

  * **TUI:** `bun run --filter @evalops/tui build` OR `npx nx run tui:build`
  * **Web:** `bun run --filter @evalops/composer-web build` OR `npx nx run composer-web:build`

#### Targeted Testing

  * **Vitest Filter:** `bunx vitest --run -t "<test name>"`

### Pull Request Standards

**Pre-Commit Checklist:**

1.  `bun run bun:lint`
2.  `npx nx run composer:test --skip-nx-cache`
3.  Build any touched packages (e.g., `npx nx run tui:build`)

**Requirements:**

  * **Branching:** Branch off `main`. Never commit directly to `main`.
  * **Title:** `[composer] <imperative short description>`
  * **CI Skips:** If skipping a validator (e.g., `[skip ci]` or `[skip nix]`), you **must** explain why in the PR body.

-----

## 2\. Agent Core Architecture

### Operating Principles

1.  **Explicit Over Implicit:** All actions route through visible commands (`/run`, `/config`). No hidden retries or background magic.
2.  **Deterministic Tooling:** Filesystem interactions use transparent, git-aware helpers.
3.  **Provider Agnostic:** Context loading is designed to be portable across Anthropic, OpenAI, Gemini, and Groq.
4.  **Security Model:**
      * **Default:** "YOLO Mode" (Full Trust).
      * **Safe Mode:** Activated via `COMPOSER_SAFE_MODE=1` (Requires permission for mutations).

### Context Injection Strategy

Composer constructs its system prompt by layering context files in the following priority (most specific wins):

1.  **Global Defaults:** `~/.composer/agent/AGENT.md`
2.  **Parent Directories:** Walks up the tree, aggregating instructions.
3.  **Project Root:** `AGENT.md` or `CLAUDE.md` in the current workspace.

#### Standard `AGENT.md` Template

```markdown
# Project Context

## Tech Stack
- **Framework:** [e.g. React, Vue]
- **Language:** [e.g. TypeScript, Python]
- **Build:** [e.g. Vite, Nx]

## Coding Standards
- [ ] Use functional components with hooks
- [ ] Prefer async/await over callbacks
- [ ] Error handling is mandatory

## Architecture Map
src/
  components/  # UI Elements
  utils/       # Pure functions
  api/         # Network layer

## Commands
- Dev: `npm run dev`
- Test: `npm test`
```

-----

## 3\. Tool Registry

### 📂 File & Git Operations

| Tool | Description | Constraints |
| :--- | :--- | :--- |
| **read** | Read text/images. | Supports offset/limit for large files. |
| **write** | Create/Overwrite files. | Auto-creates parent directories. |
| **edit** | Exact text replacement. | Fails if multiple matches found. |
| **list** | List directory contents. | Uses glob filtering. |
| **search** | Ripgrep-backed search. | Supports regex. |
| **diff** | Inspect git changes. | View working tree, staged, or revisions. |
| **git\_cmd** | General git operations. | **Always** run `git status` first. Never use `-i`. |

### Web & External

| Tool | Description | Requirements |
| :--- | :--- | :--- |
| **websearch** | Exa AI general search. | `EXA_API_KEY` |
| **codesearch** | GitHub/StackOverflow search. | `EXA_API_KEY` |
| **gh\_pr** | Manage Pull Requests. | `gh` CLI installed. |
| **gh\_issue** | Manage Issues. | `gh` CLI installed. |

### ⚡ Execution & Batching

| Tool | Description | Best Practices |
| :--- | :--- | :--- |
| **bash** | Shell execution. | Use absolute paths. Quote special chars. |
| **background_tasks** | Long-running processes. | Use for dev servers, watch mode. Always `list` before starting duplicates. |
| **batch** | Parallel execution (1-10). | **Read-only operations only.** Never batch mutations. |

### 🔄 Background Task Management

The `background_tasks` tool manages long-running processes across agent interactions:

**Actions:**
- `start` - Launch a background command with optional restart policy
- `stop` - Terminate a running task by ID
- `list` - View all active tasks with status and resource usage
- `logs` - Tail task output (default 40 lines, max 200)

**Parameters for `start`:**
- `command` (required) - Command to run in the background
- `shell` (optional) - Set `true` for shell mode (enables pipes/redirects like `cmd1 | cmd2`)
- `cwd` (optional) - Working directory for the command
- `env` (optional) - Additional environment variables
- `restart` (optional) - Auto-restart policy with:
  - `maxAttempts` (1-5) - Maximum restart attempts on failure
  - `delayMs` (50-60000) - Delay between restart attempts
  - `strategy` - `"fixed"` or `"exponential"` backoff
  - `maxDelayMs` - Upper bound for exponential backoff
  - `jitterRatio` (0-1) - Random jitter for restart delays

**Use Cases:**
- Development servers (`npm run dev`, `bun dev`, `vite`)
- File watchers (TypeScript compiler, Vitest, nodemon)
- Tunnel/proxy services (ngrok, localtunnel)
- Long-running build processes

**Best Practices:**
1. **Always `list` before starting** to avoid duplicate processes
2. **Use `shell: true` for pipes/redirects** (e.g., `npm run dev | tee output.log`)
3. **Check logs regularly** for errors using the `logs` action
4. **Stop tasks when done** - they'll auto-cleanup on Composer exit, but explicit stops are cleaner
5. **Use restart policies for resilient services** - ideal for dev servers that should recover from crashes
6. **Direct execution is safer** - omit `shell` parameter for simple commands without pipes

**Example Workflow:**
```bash
# Check for existing tasks
background_tasks action=list

# Start a dev server with auto-restart
background_tasks action=start command="npm run dev" cwd="./packages/web" restart={"maxAttempts": 3, "delayMs": 1000, "strategy": "exponential"}

# View recent logs
background_tasks action=logs taskId="<id>" lines=20

# Stop the task
background_tasks action=stop taskId="<id>"
```

**Log Storage:**
- Logs persist to `~/.composer/logs/background-<taskId>.log`
- Log files are truncated at 5MB to prevent disk space issues
- Use `logs` action to tail recent output without reading the entire file

-----

## 4\. System Stability & Safety

### Action Firewall (`src/safety/action-firewall.ts`)

The firewall intercepts every agent request to validate:

  * Path traversal attacks.
  * File size limits.
  * Command injection patterns.
  * Destructive patterns (e.g., `rm -rf /`).

### Error Recovery Protocols

1.  **Streaming Recovery:** Uses `partial-json` to parse interrupted streams.
2.  **Exponential Backoff:** Applied automatically to network/API errors.
3.  **Tool Failure Log:** All failures persist to `~/.composer/tool-failures.log`.

### Session Persistence

Sessions are stored as **JSONL** at `~/.composer/agent/sessions/`.

  * **Resume:** `composer -c` (latest) or `composer -r` (interactive list).
  * **Ephemeral:** `composer --no-session`.
  * **Debug:** Export sessions to HTML via `/export` for analysis.

-----

## 5\. Best Practices for Prompting Composer

1.  **Write Clear Specs:** Do not say "Make this better." Say "Refactor `src/auth` to use async/await and add Vitest coverage."
2.  **Context is King:** If the project lacks an `AGENT.md`, you must provide stack details in the prompt.
3.  **Review Loop:**
    ```bash
    composer "Implement feature X"
    git diff      # Verify logic
    git add -p    # Stage granularly
    ```
4.  **Tool Usage:** Do not ask Composer to manually read files one by one. It has `batch` capabilities for reading—encourage it to use them.
5.  **Response Style:** Keep answers concise; avoid inline dynamic imports unless absolutely necessary.

-----

## 6\. Implementation Patterns

### Event Suppression Pattern

When implementing event-emitting classes, the **silent mode** parameter pattern can suppress events during internal state operations. See [`docs/patterns/event-suppression.md`](./docs/patterns/event-suppression.md) for detailed guidelines.

**Quick Reference:**
```typescript
// ✅ Use silent mode for internal cleanup
queue.cancelAll({ silent: true });

// ❌ Don't unsubscribe/resubscribe
this.unsubscribe();
queue.cancelAll();
this.resubscribe();
```

_Note: Currently used only in PromptQueue. Document additional patterns here as the codebase evolves._

-----

### Troubleshooting

  * **Auth Error:** Check `echo $ANTHROPIC_API_KEY` and run `composer --diag`.
  * **Corrupt Session:** Delete the specific JSONL file in `~/.composer/agent/sessions/`.
  * **LSP Issues:** Restarting Composer re-initializes the LSP server automatically.
