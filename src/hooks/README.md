# TypeScript Hooks

The TypeScript hook system allows you to intercept and modify agent behavior using JavaScript/TypeScript.

## Quick Start

Create a hook file in `~/.composer/hooks/` or `.composer/hooks/`:

```typescript
// ~/.composer/hooks/my-hook.ts
import type { HookAPI } from 'composer';

export default (pi: HookAPI) => {
  // Block dangerous commands
  pi.on("PreToolUse", (input) => {
    if (input.tool_name === "Bash") {
      const cmd = input.tool_input?.command || "";
      if (cmd.includes("rm -rf /")) {
        return { block: true, reason: "Dangerous command blocked" };
      }
    }
    return { continue: true };
  });

  // Log session events
  pi.on("SessionStart", (input) => {
    console.log(`Session started: ${input.session_id}`);
  });

  // Inject context
  pi.on("PostToolUse", (input) => {
    if (input.tool_name === "Bash") {
      return {
        continue: true,
        context: `Command completed in ${input.tool_output?.length || 0} chars`
      };
    }
  });
};
```

## Hook Events

| Event | Description | Can Block | Can Modify |
|-------|-------------|-----------|------------|
| `PreToolUse` | Before tool execution | Yes | Yes (input) |
| `PostToolUse` | After tool execution | No | Yes (context) |
| `PostToolUseFailure` | After tool failure | No | No |
| `SessionStart` | Session begins | No | No |
| `SessionEnd` | Session ends | No | No |
| `SessionBeforeTree` | Before /tree navigation | Yes | Yes (summary) |
| `SessionTree` | After /tree navigation | No | No |
| `UserPromptSubmit` | User sends prompt | Yes | Yes |
| `PreCompact` | Before compaction | Yes | No |
| `Notification` | Various events | No | No |
| `Overflow` | Context overflow | Yes | No |
| `PreMessage` | Before model call | Yes | Yes (message) |
| `PostMessage` | After model response | No | No |
| `OnError` | Error occurs | Yes | No |
| `EvalGate` | After tool (eval) | No | No |
| `SubagentStart` | Subagent spawning | Yes | Yes |
| `SubagentStop` | Subagent completes | No | No |
| `PermissionRequest` | Permission needed | Yes | No |

## Input Types

Each event provides typed input:

```typescript
// PreToolUse
interface PreToolUseHookInput {
  hook_event_name: "PreToolUse";
  cwd: string;
  session_id?: string;
  timestamp: string;
  tool_name: string;
  tool_call_id: string;
  tool_input: Record<string, unknown>;
}

// PostMessage
interface PostMessageHookInput {
  hook_event_name: "PostMessage";
  cwd: string;
  session_id?: string;
  timestamp: string;
  response: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  stop_reason?: string;
}

// OnError
interface OnErrorHookInput {
  hook_event_name: "OnError";
  cwd: string;
  session_id?: string;
  timestamp: string;
  error: string;
  error_kind: string;
  context?: string;
  recoverable: boolean;
}
```

## Return Values

Hooks return an object with these optional fields:

```typescript
interface HookResult {
  // Let execution continue (default)
  continue?: boolean;

  // Block execution with reason
  block?: boolean;
  reason?: string;

  // Modify the tool input
  modified_input?: Record<string, unknown>;

  // Add context to tool output
  context?: string;
}
```

## Use Cases

### Safety & Compliance

```typescript
pi.on("PreToolUse", (input) => {
  if (input.tool_name === "Bash") {
    const cmd = input.tool_input?.command || "";

    // Block production access
    if (cmd.match(/psql.*prod|mysql.*production/)) {
      return { block: true, reason: "Production database access blocked" };
    }

    // Block destructive commands
    if (cmd.match(/rm\s+-rf\s+\/|mkfs|dd.*of=\/dev/)) {
      return { block: true, reason: "Destructive command blocked" };
    }
  }
  return { continue: true };
});
```

### Audit Logging

```typescript
import { appendFileSync } from 'fs';
import { homedir } from 'os';

pi.on("PostToolUse", (input) => {
  const log = `${new Date().toISOString()} ${input.tool_name} ${JSON.stringify(input.tool_input)}\n`;
  appendFileSync(`${homedir()}/.composer/audit.log`, log);
  return { continue: true };
});
```

### Cost Control

```typescript
let sessionTokens = 0;
const MAX_TOKENS = 500000;

pi.on("PostMessage", (input) => {
  sessionTokens += input.input_tokens + input.output_tokens;

  if (sessionTokens > MAX_TOKENS) {
    return { block: true, reason: `Token budget exceeded (${sessionTokens}/${MAX_TOKENS})` };
  }
  return { continue: true };
});
```

### Desktop Notifications

```typescript
import { exec } from 'child_process';

pi.on("SessionEnd", (input) => {
  if (process.platform === 'darwin') {
    exec(`osascript -e 'display notification "Session complete" with title "Composer"'`);
  }
});
```

### Auto-Approval

```typescript
pi.on("PermissionRequest", (input) => {
  // Auto-approve reads in documentation directories
  if (input.tool_name === "Read") {
    const path = input.tool_input?.file_path || "";
    if (path.startsWith("/usr/share/doc/") || path.includes("/README")) {
      return { continue: true }; // auto-approve
    }
  }
  return { continue: true }; // defer to normal approval
});
```

### Input Rewriting

```typescript
pi.on("PreToolUse", (input) => {
  if (input.tool_name === "Write") {
    const path = input.tool_input?.file_path || "";

    // Redirect /tmp writes to sandbox
    if (path.startsWith("/tmp/")) {
      return {
        modified_input: {
          ...input.tool_input,
          file_path: path.replace("/tmp/", "/sandbox/tmp/")
        }
      };
    }
  }
  return { continue: true };
});
```

### Subagent Control

```typescript
const ALLOWED_AGENTS = new Set(["explore", "plan", "code-reviewer"]);

pi.on("SubagentStart", (input) => {
  if (!ALLOWED_AGENTS.has(input.agent_type)) {
    return {
      block: true,
      reason: `Agent type '${input.agent_type}' not allowed`
    };
  }
  return { continue: true };
});
```

### Error Handling

```typescript
pi.on("OnError", (input) => {
  // Log errors to external service
  fetch("https://errors.example.com/log", {
    method: "POST",
    body: JSON.stringify({
      error: input.error,
      kind: input.error_kind,
      recoverable: input.recoverable
    })
  }).catch(() => {});

  // Suppress transient network errors
  if (input.error_kind === "NetworkError" && input.recoverable) {
    return { block: true }; // suppress
  }

  return { continue: true };
});
```

## Message Injection

Use `pi.send()` to inject messages into the conversation:

```typescript
pi.on("SessionStart", async () => {
  // Inject a system reminder at session start
  await pi.send({
    role: "user",
    content: "Remember: This project uses pnpm, not npm."
  });
});
```

## UI Context

Hooks can interact with the user via the UI context:

```typescript
pi.on("PermissionRequest", async (input, ui) => {
  if (input.tool_name === "Bash") {
    const confirmed = await ui.confirm({
      title: "Run command?",
      message: input.tool_input?.command
    });

    if (!confirmed) {
      return { block: true, reason: "User declined" };
    }
  }
  return { continue: true };
});
```

## File Locations

Hooks are loaded from:
- `~/.composer/hooks/*.ts` - Global hooks
- `.composer/hooks/*.ts` - Project-local hooks

## Environment Variables

```bash
# Hook configuration
COMPOSER_HOOKS_PRE_TOOL_USE="path/to/script.sh"
COMPOSER_HOOKS_POST_TOOL_USE="path/to/script.sh"

# Notification settings
COMPOSER_NOTIFY_TERMINAL=true
COMPOSER_NOTIFY_EVENTS=turn-complete,session-end,error
COMPOSER_NOTIFY_PROGRAM=/path/to/notifier
```

## hooks.json configuration (presets via `extends`)

You can also configure command and prompt hooks via JSON:

- User: `~/.composer/hooks.json`
- Project: `.composer/hooks.json`

```json
{
  "extends": [
    "my-hooks-preset",
    "./hooks.local.json"
  ],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|write",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/pre-tool.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

Notes:
- `extends` supports local files (relative to the config file) and npm packages. For packages, Composer looks for `hooks.json` at the package root.
- Project config overrides user config, and user config overrides env vars (when matcher keys collide).
- For command hooks, bare relative commands like `./scripts/check.sh` (no spaces) are resolved relative to the config file directory.
