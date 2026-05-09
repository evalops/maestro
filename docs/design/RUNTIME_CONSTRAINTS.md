# Runtime Constraints

Runtime constraint fragments are small system-prompt additions that tell the
agent about execution limits the runtime already knows. They keep environment
warnings close to prompt assembly instead of relying on every caller to restate
the same sandbox, network, or checkout caveats.

## Contract

Fragments live in `@evalops/contracts` so every Maestro surface can share the
same keys and wording:

- `RuntimeConstraintContext` describes observed runtime facts such as
  `sandboxMode`, `isShallowGitCheckout`, `networkAccess`, `readOnly`,
  `hostedRunner`, and `firewallRestricted`.
- `RuntimeConstraintDefinition` pairs a stable `contextKey`, a predicate over
  that context, and the prompt text.
- `getRuntimeConstraintFragments()` selects matching fragments.
- `buildRuntimeConstraintPrompt()` formats selected fragments as a single
  `# Runtime Constraints` system-prompt section.

The contract package stays pure. Filesystem and environment detection happens in
the caller, currently `src/cli/system-prompt.ts`, before the context is passed
into prompt finalization.

## Current Fragments

| Key | Condition | Prompt behavior |
| --- | --- | --- |
| `sandbox.filesystem` | Sandbox mode is active | Keep reads, writes, and commands inside approved workspace paths. |
| `sandbox.shallow-git` | Sandbox mode is active and the checkout has `.git/shallow` | Warn that history-sensitive commands need `git fetch --unshallow`. |
| `hosted-runner.ephemeral` | Hosted runner env is detected | Treat the workspace as ephemeral and avoid printing secrets. |
| `network.offline` | `networkAccess` is `disabled` | Skip web search and expect external network calls to fail. |
| `network.restricted` | `networkAccess` is `restricted` or firewall restriction is detected | Avoid repeated network probes and prefer local/configured routes. |
| `checkout.read-only` | Read-only mode is active | Inspect and plan without attempting file edits or mutating commands. |

## Detection

The default detector uses explicit CLI/runtime inputs first and environment
signals second:

- `MAESTRO_SANDBOX_MODE`, `CODEX_SANDBOX_MODE`, or legacy
  `MAESTRO_SANDBOX` for sandbox mode. Policy env values are preferred over
  backend markers.
- `.git/shallow`, including worktree `.git` files, for shallow checkouts.
- `MAESTRO_OFFLINE_EVAL=1` or `CODEX_OFFLINE_EVAL=1` for offline evals.
- `MAESTRO_NETWORK_ACCESS` or `CODEX_NETWORK_ACCESS` for `available`,
  `restricted`, or `disabled` network access.
- `MAESTRO_FIREWALL_RESTRICTED=1` or `CODEX_FIREWALL_RESTRICTED=1` for
  firewall-restricted network egress.
- `MAESTRO_HOSTED_RUNNER=1` or `MAESTRO_RUNNER_KIND=hosted` for hosted runners.
- `MAESTRO_READ_ONLY=1`, `CODEX_READ_ONLY=1`, or CLI read-only flags for
  read-only checkouts.

Callers that already have authoritative runtime facts should pass them directly
instead of re-deriving from environment variables.
