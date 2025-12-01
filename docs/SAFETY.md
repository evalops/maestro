# Safety & Action Approvals

Composer executes shell commands and writes files on your machine, so it ships
with a conservative “action firewall” and approval system. This guide explains
how commands are vetted and how you can extend or relax the defaults.

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
  `COMPOSER_APPROVAL_MODE=auto`. Only do this in trusted sandboxes.

## Approval Modes

You control approval behavior via CLI flag or env var:

| Mode    | Behavior                                             |
| ------- | ---------------------------------------------------- |
| `prompt` (default) | Ask the user in the TUI; fail in headless mode |
| `auto`  | Automatically approve (use carefully)                |
| `fail`  | Immediately reject high-risk commands                |

Safe mode (`COMPOSER_SAFE_MODE=1` or `--safe-mode`) additionally disables shell
writes (chmod, mv) unless explicitly approved and surfaces a shield icon in the
footer.

## Sandbox Mode

Composer supports running tool operations in an isolated sandbox environment,
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
composer --sandbox docker
composer exec --sandbox docker "Analyze this codebase"
```

Via environment variable:
```bash
export COMPOSER_SANDBOX_MODE=docker
composer
```

Via configuration file (`.composer/sandbox.json`):
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

If Docker is unavailable, Composer falls back to local mode with a warning.

## Best Practices

- Keep the firewall enabled locally; treat `auto` mode as CI-only.
- Use `--sandbox docker` when exploring untrusted repositories.
- If a legitimate command trips a rule, prefer an explicit approval over
  disabling the rule. If you need a custom rule, submit a PR so others benefit.
- Document approvals in team workflows: "Composer asked to run `rm -rf`.
  Approved because we're deleting `tmp/`."
