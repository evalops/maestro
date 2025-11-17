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

## Best Practices

- Keep the firewall enabled locally; treat `auto` mode as CI-only.
- If a legitimate command trips a rule, prefer an explicit approval over
  disabling the rule. If you need a custom rule, submit a PR so others benefit.
- Document approvals in team workflows: “Composer asked to run `rm -rf`.
  Approved because we’re deleting `tmp/`.”
