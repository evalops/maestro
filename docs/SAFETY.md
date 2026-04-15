# Safety & Action Approvals

Audience: operators and contributors configuring approvals/sandboxing.  
Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Web UI](WEB_UI.md) · [Tools Reference](TOOLS_REFERENCE.md)

Contents: [Action Firewall](#action-firewall) · [Approval Modes](#approval-modes) · [Safe Mode](#safe-mode) · [Sandbox Execution](#sandbox-execution) · [Guardian](#guardian) · [Troubleshooting](#troubleshooting)

Maestro executes shell commands and writes files on your machine, so it ships
with a conservative “action firewall” and approval system. This guide explains
how commands are vetted and how you can extend or relax the defaults.

**Web auto-approval:** The web server runs with auto-approval for tools (see `docs/WEB_UI.md`). If you expose it outside a local sandbox, pair it with Docker/file mount constraints or add auth in front.

## Action Firewall

Located in `src/safety/action-firewall.ts`, the firewall inspects the tool name
and its arguments before execution. The default rules watch for high-risk bash
patterns such as:

| Rule ID         | Pattern                         | Description                    |
| --------------- | -------------------------------- | ------------------------------ |
| `bash-rm-rf`    | `rm -rf` (+ variants)            | Destructive recursive delete   |
| `bash-mkfs`     | `mkfs` or `mkfs.<fs>`           | Filesystem formatting          |
| `bash-disk-zero`| `dd if=/dev/zero` or `/dev/null` | Disk zeroing                   |
| `bash-chmod-000`| `chmod 0000` variants            | Permission removal (lockout)   |

If a command matches, the verdict is `require_approval` and the agent pauses.
You’ll see a prompt in the TUI asking to allow or deny; CLI mode errors out
unless you set `--approval-mode auto`.

### Extending or Disabling Rules

- To add rules, instantiate `new ActionFirewall([...defaultFirewallRules, myRule])`
  and pass it to the agent constructor.
- To disable approvals entirely, use `--approval-mode auto` (CLI) or set
  `MAESTRO_APPROVAL_MODE=auto`. Only do this in trusted sandboxes.

### Bash Guard / YOLO toggle

The tree-sitter/bash guard can feel heavy-handed. Control it with
`MAESTRO_BASH_GUARD`:

| Value | Effect |
| ----- | ------ |
| unset | Guard **on** (current default) |
| `1`/`on`/`true` | Force the guard on (extra scrutiny, approvals for pipes/exec/etc.) |
| `0`/`off`/`false` | YOLO mode: skip the bash guard and rely only on the hard regex rules (still blocks `rm -rf`, `mkfs`, etc.) |

Use `0` only in trusted environments; it removes the tree-sitter and heuristic
checks that would normally require approvals for risky shell shapes (pipes,
command substitution, curl | sh, etc.). Safe mode / prod profile still keep the
rest of the firewall (system paths, containment, regex rules) in place.

### Bash allowlist (reduce false positives)

Place common-safe commands in `.maestro/bash-allow.json` (workspace) or
`~/.maestro/bash-allow.json` (user). Format: either an array or `{ "allow":
["pattern", ...] }` with glob-style patterns (minimatch). Example:

```json
{
  "allow": [
    "git status",
    "ls | wc -l",
    "npm run build",
    "git log --oneline | head -5"
  ]
}
```

You can also point to custom files via `MAESTRO_BASH_ALLOWLIST_PATHS` (path
delimiter separated).

### Shell egress kill switch

Set `MAESTRO_NO_EGRESS_SHELL=1` to require approval for shell commands that use
curl/wget/ssh/nc or `/dev/tcp`. Override per-run with
`MAESTRO_ALLOW_EGRESS_SHELL=1` or by allowlisting the specific command.

## Approval Modes

You control approval behavior via CLI flag or env var:

| Mode    | Behavior                                             |
| ------- | ---------------------------------------------------- |
| `prompt` (default) | Ask the user in the TUI; fail in headless mode |
| `auto`  | Automatically approve (use carefully)                |
| `fail`  | Immediately reject high-risk commands                |

Safe mode (`MAESTRO_SAFE_MODE=1` or `--safe-mode`) additionally disables shell
writes (chmod, mv) unless explicitly approved and surfaces a shield icon in the
footer.

## Sandbox Mode

Maestro supports running tool operations in an isolated sandbox environment,
providing an extra layer of protection when exploring untrusted code.

### Available Modes

| Mode    | Description                                           |
| ------- | ----------------------------------------------------- |
| `none`  | No sandbox (default) - tools run directly on the host |
| `local` | Local sandbox - minimal isolation (same as `none`)    |
| `docker`| Docker container - full isolation                     |

### Enabling Sandbox Mode

Via CLI flag:
```bash
maestro --sandbox docker
maestro exec --sandbox docker "Analyze this codebase"
```

Via environment variable:
```bash
export MAESTRO_SANDBOX_MODE=docker
maestro
```

Via configuration file (`.maestro/sandbox.json`):
```json
{
  "mode": "docker",
  "docker": {
    "image": "node:20-slim",
    "workspaceMount": "/workspace"
  }
}
```

### Docker Sandbox Details

When using Docker mode:
- A detached container is started with your workspace mounted
- All bash commands execute inside the container
- File operations (read, write, edit) are sandboxed
- Container is cleaned up on exit

Requirements:
- Docker must be installed and running
- Current user must have permission to run Docker commands

If Docker is unavailable, Maestro falls back to local mode with a warning.

## Best Practices

- Keep the firewall enabled locally; treat `auto` mode as CI-only.
- Use `--sandbox docker` when exploring untrusted repositories.
- If a legitimate command trips a rule, prefer an explicit approval over
  disabling the rule. If you need a custom rule, submit a PR so others benefit.
- Document approvals in team workflows: "Maestro asked to run `rm -rf`.
  Approved because we're deleting `tmp/`."
- When adjusting system-protected paths, update `docs/system-paths.json` and
  run `node scripts/validate-system-paths.js` (or `bun run bun:lint`) to catch
  Windows backslash escaping issues.

## Hardened “prod” profile

Enable secure defaults by setting `MAESTRO_PROFILE=prod` (or `MAESTRO_WEB_PROFILE=prod` for web-only). This is meant for hosted or shared environments; local dev stays lenient unless you opt in.

What it flips on by default:
- Approval mode defaults to `fail` (can still be overridden explicitly).
- Strict egress tagging: human-facing tools must be annotated in `TOOL_TAGS`; untagged egress is blocked unless `MAESTRO_FAIL_UNTAGGED_EGRESS=0`.
- Background shell tasks blocked when launched with `background_tasks` + `shell:true` unless `MAESTRO_BACKGROUND_SHELL_DISABLE=0`.
- Safe mode and plan-required guards are enabled.
- Web security headers (CSP, Referrer-Policy, Permissions-Policy, X-Content-Type-Options) are emitted for static assets.
- CSRF enforcement is activated when `MAESTRO_WEB_CSRF_TOKEN` is set (auto-required in prod profile unless `MAESTRO_WEB_REQUIRE_CSRF=0`).

Recommended hardened web start:
```bash
MAESTRO_PROFILE=prod \
MAESTRO_WEB_API_KEY=<strong-token> \
MAESTRO_WEB_CSRF_TOKEN=<csrf-secret> \
MAESTRO_WEB_ORIGIN=https://your.host \
maestro web
```

Temporarily relax for local hacking:
```bash
MAESTRO_PROFILE=dev \
MAESTRO_FAIL_UNTAGGED_EGRESS=0 \
MAESTRO_BACKGROUND_SHELL_DISABLE=0
```
