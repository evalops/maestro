# Learnings from oh-my-opencode

**Source**: https://github.com/code-yeongyu/oh-my-opencode (567 stars)
**Analysis Date**: 2025-12-16

This document compares oh-my-opencode patterns against Composer's existing implementation to identify genuine gaps and opportunities.

---

## Executive Summary

oh-my-opencode is an OpenCode plugin adding multi-model orchestration, background agents, and smart context management. After deep review of Composer's architecture, here's what's **genuinely new** vs **already present**:

### Already Present in Composer ✅
- Hook system (more sophisticated - Lua/WASM/native backends)
- Session management (JSONL-based, branching support)
- Safety/firewall system (tree-sitter bash analysis)
- Tool registry with approval workflows
- MCP integration
- Swarm mode for multi-agent orchestration
- Background task spawning via Tokio
- Context file loading (AGENT.md/CLAUDE.md)
- Doom loop detection

### Genuinely New Ideas 🆕
1. **Todo Continuation Enforcer** - Auto-continue when todos remain
2. **Specialized Model-Routed Agents** (Oracle/Librarian/Explore patterns)
3. **Context Window Monitor** - Remind at 70% to prevent rushed work
4. **Keyword Detector** - Detect "ultrathink", "thorough" in prompts
5. **AST-Grep Tools** - AST-aware code search/replace
6. **LSP as Agent Tools** - Expose rename, references, code actions
7. **Rules Injector** - Glob-based conditional rule injection

---

## 1. Todo Continuation Enforcer (NEW)

**What it does**: When session goes idle with incomplete todos, auto-injects continuation prompt.

**oh-my-opencode implementation**:
```typescript
const CONTINUATION_PROMPT = `[SYSTEM REMINDER - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done`
```

**Key features**:
- Debounced (200ms delay to avoid race conditions)
- Respects interrupt/error states (no infinite loops)
- Tracks "reminded" sessions to avoid spam
- Wired with session recovery to skip during recovery

**Composer gap**: The TypeScript CLI has todo tracking but no auto-continuation. The agent relies on the LLM remembering todos.

**Implementation location**: Could be added to `packages/tui-rs/src/hooks/` as a new hook type or as agent-level behavior in `native.rs`.

---

## 2. Specialized Model-Routed Agents (PARTIALLY NEW)

Composer has **Swarm mode** for parallel task execution, but oh-my-opencode's pattern is different:

**oh-my-opencode pattern**:
| Agent | Model | Role | Always Available |
|-------|-------|------|------------------|
| OmO | claude-opus-4-5 | Orchestrator | Yes (main) |
| oracle | gpt-5.2 | Architecture advisor | On-demand |
| librarian | claude-sonnet-4-5 | External docs/OSS | Background |
| explore | grok-code | Fast codebase search | Background |

**Key insight**: Different models excel at different tasks:
- GPT-5.2 for logical reasoning/architecture
- Grok for fast, cheap codebase exploration
- Gemini for creative UI work

**Composer gap**: Single-model per session. Swarm spawns parallel tasks but doesn't route to specialized models.

**Implementation opportunity**:
```rust
// In native.rs or new subagent module
pub struct SubagentConfig {
    pub name: String,
    pub model: String,           // Can differ from main agent
    pub tools: ToolRestrictions, // Subset of tools
    pub prompt: String,          // Specialized system prompt
    pub mode: SubagentMode,      // Background | Blocking | Advisory
}
```

---

## 3. Context Window Monitor (NEW)

**What it does**: At 70% context usage, injects reminder to prevent rushed/incomplete work.

```typescript
const CONTEXT_REMINDER = `[SYSTEM REMINDER - 1M Context Window]

You are using Anthropic Claude with 1M context window.
You have plenty of context remaining - do NOT rush or skip tasks.
Complete your work thoroughly and methodically.`
```

**Why it matters**: LLMs sometimes "sense" context pressure and start rushing or summarizing prematurely.

**Composer gap**: Has compaction (`/compact`) but no proactive monitoring.

**Implementation**: Add to hook system - fire on `PostToolUse` when token count crosses threshold.

---

## 4. Keyword Detector (NEW)

**Detects special keywords to adjust behavior**:
- `ultrawork` / `ulw` → Maximum parallel agent orchestration
- `search` / `find` → Maximize search effort
- `analyze` / `investigate` → Deep analysis mode
- `ultrathink` → Extended thinking budget

**Composer gap**: Thinking level is manual (`/thinking` command). No auto-detection.

**Implementation**: Add to `PreMessage` hook - scan user message for keywords, adjust `thinking_budget` or spawn specialized agents.

---

## 5. AST-Grep Tools (NEW)

**What it does**: AST-aware code search and replace across 25 languages.

```typescript
ast_grep_search({
  pattern: 'console.log($MSG)',
  lang: 'typescript',
  paths: ['src/']
})

ast_grep_replace({
  pattern: 'console.log($MSG)',
  rewrite: 'logger.info($MSG)',
  lang: 'typescript',
  dryRun: true
})
```

**Meta-variables**:
- `$VAR` - single node
- `$$$` - multiple nodes

**Composer gap**: Has `grep` (ripgrep) but no AST-aware search. AST-grep is more precise for refactoring.

**Implementation**: Add `ast_grep_search` and `ast_grep_replace` tools. Depends on `@ast-grep/napi` or CLI.

---

## 6. LSP as Agent Tools (PARTIALLY NEW)

Composer has LSP integration for diagnostics but doesn't expose it as agent-callable tools:

**oh-my-opencode exposes**:
| Tool | Purpose |
|------|---------|
| `lsp_hover` | Type info at position |
| `lsp_goto_definition` | Jump to definition |
| `lsp_find_references` | Find all usages |
| `lsp_rename` | Rename across workspace |
| `lsp_code_actions` | Get quick fixes |
| `lsp_code_action_resolve` | Apply fix |

**Composer gap**: LSP used internally but not as tools. Agent can't say "rename this symbol" or "find all references".

**Implementation**: Expose existing LSP client methods as tools in `packages/tui-rs/src/tools/`.

---

## 7. Rules Injector (NEW)

**What it does**: Injects rules from `.claude/rules/` based on file globs.

```markdown
---
globs: ["*.ts", "src/**/*.js"]
description: "TypeScript coding rules"
---
- Use PascalCase for interface names
- Use camelCase for function names
```

**Trigger**: When agent reads/writes a matching file, rules are injected into context.

**Composer gap**: Has AGENT.md loading but no glob-based conditional rules.

**Implementation**: Add `PostToolUse` hook for `read`/`write`/`edit` that checks `.composer/rules/*.md` against file path.

---

## 8. Agent Prompt Structure (ADOPTABLE PATTERN)

OmO's prompt is exceptionally well-structured:

### Phase 0 - Intent Gate (EVERY message)
| Type | Signal | Action |
|------|--------|--------|
| Trivial | Single file, known location | Direct tools only |
| Explicit | Specific file/line | Execute directly |
| Exploratory | "How does X work?" | Assess scope first |
| Open-ended | "Improve", "Refactor" | Assess codebase first |
| Ambiguous | Unclear scope | Ask ONE question |

### Hard Blocks
- Frontend files (.tsx/.jsx/.vue) → Always delegate
- Type suppression (`as any`, `@ts-ignore`) → Never
- Commit without request → Never
- Speculate about unread code → Never

### Evidence Requirements
| Action | Required Evidence |
|--------|-------------------|
| File edit | `lsp_diagnostics` clean |
| Build command | Exit code 0 |
| Test run | Pass |
| Delegation | Agent result verified |

**Composer opportunity**: Incorporate these patterns into system prompt or AGENT.md template.

---

## 9. Delegation Prompt Structure (ADOPTABLE PATTERN)

When delegating to subagents:

```
1. TASK: Atomic, specific goal
2. EXPECTED OUTCOME: Concrete deliverables with success criteria
3. REQUIRED SKILLS: Which skill to invoke
4. REQUIRED TOOLS: Explicit tool whitelist
5. MUST DO: Exhaustive requirements
6. MUST NOT DO: Forbidden actions
7. CONTEXT: File paths, patterns, constraints
```

**Composer opportunity**: Use this structure in Swarm task definitions.

---

## 10. Background Agent Notifications (PARTIALLY NEW)

**oh-my-opencode pattern**:
1. Launch agent in background → get `task_id`
2. Continue working
3. When agent completes → inject notification into parent session
4. User can call `background_output(task_id)` to get results

**Composer's Swarm mode** has similar parallel execution but:
- No fire-and-forget pattern
- No notification injection
- No `background_output` retrieval

**Implementation opportunity**: Add `background_task`, `background_output`, `background_cancel` tools.

---

## 11. Priority Implementation Recommendations

### High Priority (Unique Value-Add)

1. **Todo Continuation Enforcer**
   - Prevents agent from stopping mid-task
   - Relatively simple hook implementation
   - High user impact

2. **Context Window Monitor**
   - Prevents rushed/incomplete work
   - Simple token counting in PostToolUse
   - User-visible reassurance

3. **AST-Grep Tools**
   - Precise refactoring capability
   - Dependency: `@ast-grep/napi`
   - Differentiator vs other agents

### Medium Priority (Enhancement)

4. **Keyword Detector**
   - Auto-adjust thinking budget
   - Low implementation effort

5. **LSP Tools**
   - Expose existing functionality
   - Enables "rename this" commands

6. **Rules Injector**
   - Conditional context injection
   - More flexible than AGENT.md

### Lower Priority (Already Covered)

7. **Multi-model Subagents**
   - Swarm mode partially covers this
   - Would need model-routing logic

8. **Background Agent Notifications**
   - Nice-to-have for long tasks
   - Swarm handles most use cases

---

## 12. Implementation Notes

### Where to Add in Composer

| Feature | Location |
|---------|----------|
| Todo Continuation | `packages/tui-rs/src/hooks/continuation.rs` (new) |
| Context Monitor | `packages/tui-rs/src/hooks/context_monitor.rs` (new) |
| Keyword Detector | `packages/tui-rs/src/hooks/keyword_detector.rs` (new) |
| AST-Grep Tools | `packages/tui-rs/src/tools/ast_grep.rs` (new) |
| LSP Tools | `packages/tui-rs/src/tools/lsp.rs` (new) |
| Rules Injector | `packages/tui-rs/src/hooks/rules_injector.rs` (new) |

### Dependencies to Add

```toml
# Cargo.toml (if using Rust bindings)
ast-grep-core = "0.x"

# Or shell out to CLI
# ast-grep/cli already installed
```

---

## Conclusion

Composer's architecture is more sophisticated than oh-my-opencode in several areas (Rust performance, Lua/WASM hooks, Swarm parallelism). The genuine gaps are:

1. **Behavioral nudges** - Todo continuation, context monitoring, keyword detection
2. **AST-aware tools** - ast-grep search/replace
3. **LSP exposure** - Make existing LSP callable by agent
4. **Conditional rules** - Glob-based rule injection

These are all additive enhancements that fit cleanly into Composer's existing hook and tool systems.
