# Safety and Action Approvals

> **Status:** Current Rust runtime. The controls documented here live under
> `packages/tui-rs/src/safety/`, `packages/tui-rs/src/sandbox.rs`, and
> `packages/control-plane-rs/src/auth.rs`.

Audience: operators and contributors configuring approvals and sandboxing.

Nav: [Docs index](README.md) · [Quickstart](QUICKSTART.md) · [Web UI](WEB_UI.md)

Maestro can execute shell commands and change files on the host. The action
firewall, approval flow, policy checks, and optional native sandbox are
independent layers. No layer makes an untrusted repository safe by itself.

## Action firewall

`packages/tui-rs/src/safety/firewall.rs` is the central tool-call checkpoint.
It returns one of:

- `Allow`
- `RequireApproval`
- `Block`

For bash, the firewall combines high-severity dangerous-pattern blocks with
parsed command analysis. The rules cover destructive operations, filesystem
formatting, disk writes, privilege changes, shell metacharacter risk, and
other command shapes. File reads/writes and path-bearing tools also pass
containment and policy checks.

The firewall checks network-tool URLs against the enterprise policy and
requires approval for MCP tools by default. Server-provided MCP annotations
cannot lower that approval requirement.

### Approval modes

Use `--approval-mode` or `MAESTRO_APPROVAL_MODE`:

| Mode | Behavior |
| --- | --- |
| `prompt` | Ask the user for approval; approval-gated work fails when no interactive approver exists. |
| `auto` | Approve approval-gated work automatically. Use only in a trusted, isolated environment. |
| `fail` | Reject approval-gated work immediately. |

High-severity firewall blocks remain blocks; changing approval mode does not
turn them into allowed operations. A request to bypass an active native
sandbox (`bypass_sandbox: true`) is separately approval-gated.

### Bash guard and egress

The bash analyzer is enabled by default. `MAESTRO_BASH_GUARD=1` forces it on;
`MAESTRO_BASH_GUARD=0` disables the additional analysis and leaves the
hard-pattern and path/policy checks in place. Use the latter only for trusted
compatibility cases.

Set `MAESTRO_NO_EGRESS_SHELL=1` to require approval for shell commands
containing common egress primitives such as `curl`, `wget`, `ssh`, `scp`, `nc`,
or `/dev/tcp`. An explicit allowlist or
`MAESTRO_ALLOW_EGRESS_SHELL=1` can override that gate; review such overrides.

### Enterprise policy

The policy loader checks, in order, explicit paths in
`MAESTRO_ENTERPRISE_POLICY_PATH` and `MAESTRO_POLICY_PATH`, then
`$MAESTRO_HOME/policy.json` or the legacy Composer home. Policy can constrain:

- tools, commands, dependencies, and models;
- filesystem paths;
- allowed/blocked network hosts and private or localhost addresses; and
- token, session-duration, and concurrent-session limits.

Malformed or unreadable policy fails closed. Keep policy files owner-readable
and validate changes before deploying them.

## Safe mode

Set `MAESTRO_SAFE_MODE=1` to enable the safe-mode gates in
`packages/tui-rs/src/safety/safe_mode.rs`. With plan requirements enabled,
mutating tools require a satisfied plan. Validators can run after file changes,
and configured LSP diagnostics can block unsafe results.

`MAESTRO_SAFE_REQUIRE_PLAN=0` disables only the plan requirement; it does not
disable the action firewall or path containment. Use `/sandbox` in the
interactive UI to inspect the active native policy.

## Native sandbox

`packages/tui-rs/src/sandbox.rs` defines three policies:

| Policy | Effect |
| --- | --- |
| `read-only` | No filesystem writes and no network access for the sandboxed child. |
| `workspace-write` | Writes are limited to the workspace and configured writable roots; network access is explicit in the policy. |
| `danger-full-access` | No native filesystem or network restriction. |

Platform backends:

- macOS: Seatbelt via `/usr/bin/sandbox-exec`;
- Linux: Landlock for filesystem access plus seccomp for network-disabled
  policies;
- other platforms: native sandboxing is unavailable.

The sandbox is applied in the child immediately before `exec`. The child
environment is cleared and replaced with the filtered environment passed by
the executor. If the native mechanism is unavailable, the current interactive
path reports the condition rather than silently claiming isolation. Verify the
status in the TUI and use OS/container isolation when enforcement is required.

The `danger-full-access` policy is an explicit escape hatch, not a safe
default. Avoid `bypass_sandbox` and full-access mode for untrusted work.

## Credentials and PII

`packages/tui-rs/src/agent/credential_store.rs` recognizes and redacts common
credential formats in tool arguments and serialized output. The workflow
tracker in `safety/workflow_state.rs` can block unredacted PII before
human-facing tools.

These are pattern-based controls, not a guarantee. Do not paste long-lived
secrets into prompts or use an untrusted repository with a credential that can
modify production systems. Anything intentionally sent to a model provider or
external tool is disclosed to that service.

## Control-plane safety

For a shared or remote web deployment:

```
MAESTRO_PROFILE=prod \
MAESTRO_WEB_API_KEY="$(openssl rand -hex 32)" \
MAESTRO_WEB_CSRF_TOKEN="$(openssl rand -hex 32)" \
maestro web
```

The control plane requires authentication on non-loopback binds. It accepts
API-key, shared-secret, JWT/JWKS, or trusted-proxy authentication as described
in `docs/THREAT_MODEL.md`. State-changing API and A2A requests are CSRF
protected when CSRF enforcement is enabled. `MAESTRO_WEB_REQUIRE_KEY=0` is a
loopback-only development switch.

The Rust control plane does not provide general RBAC or SSO. If remote access
depends on a proxy for identity or authorization, make that proxy part of the
deployment threat model.

## Release and extension safety

The installer verifies a release checksum and, when the release publishes the
signed bundle, verifies its Cosign identity before atomically switching the
launcher. Set `MAESTRO_REQUIRE_SIGNED_INSTALL=1` to reject unsigned legacy
artifacts.

MCP servers are separate trust boundaries with broad tool access. Pin and
review them before enabling them. The `maestro-execpolicy` crate is currently a
dependency-light parsing/migration leaf and is not the live approval path.

## Recommended operating posture

- Use `prompt` or `fail` approval for untrusted work.
- Prefer `read-only` or `workspace-write` native sandboxing.
- Set `MAESTRO_NO_EGRESS_SHELL=1` for sensitive repositories.
- Use `MAESTRO_PROFILE=prod` for shared control-plane deployments.
- Keep provider and MCP credentials short-lived and least-privileged.
- Run `maestro setup` after installation and `maestro doctor --live` when
  diagnosing a deployment; do not paste diagnostic secrets into tickets.
