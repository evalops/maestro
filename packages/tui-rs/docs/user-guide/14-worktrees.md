# Worktrees

Maestro can create or reuse a git worktree under the repo for isolated agent work, then launch the native TUI inside that tree.

---

## Usage

```bash
# Auto-named worktree (maestro-<timestamp> style)
maestro --worktree "implement feature X"

# Named worktree
maestro --worktree=feat-x "implement feature X"
maestro --worktree feat-x "implement feature X"
```

Native binary equivalent:

```bash
maestro-tui --worktree feat-x
maestro-tui --worktree=feat-x "prompt"
```

---

## Layout

Worktrees live under the repository root:

```text
<repo>/.maestro/worktrees/<name>/
```

- If the path already exists, Maestro reuses it.
- Otherwise it runs `git worktree add` (new branch from HEAD when creating).
- Requires a git repository; fails clearly if git is unavailable or the add fails.

---

## When to use

| Scenario | Why |
|----------|-----|
| Parallel experiments | Keep dirty trees out of your main checkout |
| Long agent tasks | Isolate file writes and branch state |
| Review / try a risky change | Easy to discard a worktree later |

Manual cleanup (standard git):

```bash
git worktree list
git worktree remove .maestro/worktrees/feat-x
```

---

## Interaction with sessions and config

- Sessions key off the worktree cwd, so transcripts stay per-worktree path.
- Project config under `.maestro/` on the main repo is available once you are inside the worktree; the worktree itself sits under `.maestro/worktrees/`.
- Hooks, MCP, and skills resolve from the active cwd’s project files plus user home config.

---

## Tips

- Name worktrees after branches or tickets (`feat-login`, `fix-1234`).
- Do not commit secrets into worktree-only scratch files; treat them like normal git checkouts.
- Combine with plan mode (`/plan`) when you want design-before-mutate in an isolated tree.
