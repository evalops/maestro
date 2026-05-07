# Guarded Files

Guarded files are user or editor configuration paths that Maestro must not read
or mutate silently. The default policy is intentionally conservative: any match
requires explicit user approval through prompt mode, even when the action
firewall or permission hooks would otherwise allow the tool call.

## Default Categories

The built-in rule is `default-guarded-file`. It covers:

- Cursor configuration
- Windsurf configuration
- Antigravity configuration
- JetBrains application and project configuration
- Neovim configuration
- Amp settings
- Shell configuration
- SSH and GPG keys

The matcher expands `~`, shell environment variables, Windows profile tokens,
and relative paths where the tool call supplies a working directory. It checks
direct file tools such as `read`, `write`, and `edit`, search/list tools, and
paths found in shell commands.

## Runtime Behavior

Guarded file access has a hard prompt-mode requirement:

1. A guarded path is detected before tool execution.
2. PermissionRequest hooks may deny the request, but they may not auto-allow it.
3. If approval mode is not `prompt`, the call is blocked with the guarded-file
   reason and no approval request is sent to the approval service.
4. If approval mode is `prompt`, Maestro emits the normal
   `action_approval_required` event and waits for the user decision.

This keeps local safety policy and MCP trust aligned around the same principle:
tools can be powerful, but trust is explicit and scoped to the risky surface.
MCP server trust is documented separately in [MCP Trust](MCP_TRUST.md).

## Audit Contract

Every guarded-file approval prompt or non-interactive guarded-file block records
an `ApprovalHit` telemetry event with:

```json
{
  "policy_id": "guardedFiles_block",
  "risk_level": "guarded_file",
  "context": {
    "tool_name": "read",
    "args": { "path": "~/.ssh/config" },
    "guarded_file": {
      "rule_id": "default-guarded-file",
      "category": "SSH and GPG keys",
      "pattern": "**/.ssh/**",
      "path": "~/.ssh/config",
      "action": "read"
    }
  }
}
```

Shell-backed tools report `action: "execute"` because their command text can
mix reads and writes. Unknown custom tools report `action: "unknown"` until they
are classified.

The event correlation uses the session id and tool-call id so Platform audit and
governance consumers can join guarded-file decisions back to the run timeline.

## Overrides

The runtime accepts normalized user and organization `guardedFiles` settings:

```json
{
  "guardedFiles": {
    "allowlist": ["amp-settings", "/Users/me/special/.ssh/internal-only"],
    "rules": [
      {
        "key": "org-secrets",
        "description": "Organization secret fixtures",
        "patterns": ["**/.secrets/**"],
        "defaultBehavior": "block"
      }
    ],
    "mandatoryKeys": ["ssh-gpg-keys"]
  }
}
```

Allowlist entries can be guard keys or path/glob entries. Organization and user
custom rules extend the default list; they do not replace it. Mandatory keys win
over allowlists, so an organization can require a guard category to remain
approval-gated even when a user has an allowlist entry for that key or path.

The current UI/API management surface is intentionally minimal. Runtime callers
can pass the policy directly, and the database settings types preserve the
shape for user/org settings. A fuller administration UI can build on that
contract without weakening the default protection.
