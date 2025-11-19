# Agent Configuration & Developer Protocol

This document defines the operational parameters for **Composer**. It serves two purposes:

1.  **Developer Guide:** Instructions for humans (and agents) modifying the Composer repository.
2.  **System Architecture:** Documentation of Composer's internal behavior, prompts, and tool capabilities.

-----

## 1\. Repository Development Protocol

**Context:** This repository uses a **Bun + Nx** monorepo structure. Strict adherence to the build pipeline is required.

### 🛠 Workspace Management

| Action | Command | Context |
| :--- | :--- | :--- |
| **List Projects** | `npx nx show projects` | View all workspace targets (avoids manual scan). |
| **Visualize** | `npx nx graph --focus <project>` | Verify wiring and dependencies. |
| **Install Root** | `bun install` | Workspace-aware installation. |
| **Install Pkg** | `bun install --filter <package>` | Targeted debugging inside a package. |
| **Check Deps** | `bunx biome check .` | Run after moving files/changing imports. |

### Build & Test Workflows

**Critical:** Consult `.github/workflows/` (`evals.yml`, `nx-ci.yml`, `release.yml`) to mirror CI environments.

#### Root Commands

  * **Full Test Suite:** `npx nx run composer:test --skip-nx-cache` (Builds `tui` + `composer-web` automatically).
  * **Linting:** `bun run bun:lint` (Biome + Eval Verifier).

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
| **batch** | Parallel execution (1-10). | **Read-only operations only.** Never batch mutations. |

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

-----

### Troubleshooting

  * **Auth Error:** Check `echo $ANTHROPIC_API_KEY` and run `composer --diag`.
  * **Corrupt Session:** Delete the specific JSONL file in `~/.composer/agent/sessions/`.
  * **LSP Issues:** Restarting Composer re-initializes the LSP server automatically.
