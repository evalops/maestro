# Staged Rollout Convention

Maestro changes that add risky behavior should ship in deployable stages:

1. **Enabling primitive**: the protocol field, runtime path, mode catalog entry,
   config parser, or backend handler exists and can be exercised safely.
2. **Limited exercise**: internal usage, tenant-scoped feature flags, or
   controlled automation exercises the primitive before broad exposure.
3. **User-visible promotion**: help text, docs, UI, and default behavior expose
   the feature after the primitive has production evidence.

Do not skip directly to user-visible behavior when the change affects protocol
shape, runtime dispatch, command surface, agent modes, config compatibility, or
cross-version client behavior.

## Choosing A Gate

Use the smallest gate that matches the blast radius:

- **Internal env/config primitive**: internal cutovers, runtime swaps, protocol
  escapes, and support-only migration controls. These must not appear in public
  help, onboarding docs, stable automation examples, or bespoke CLI parser
  branches.
- **Tenant/runtime feature flag**: per-org or per-user rollout where the same
  binary needs different behavior for different customers. Use `flag-control`
  or the managed rollout snapshot path.
- **Hidden user command or mode**: only for features we explicitly want power
  users or support to invoke from the external CLI before promotion. Hidden
  commands are still external surface area, so they need telemetry, an owner,
  and a planned promotion or removal date.

Runtime escape switches for headless protocol cutovers use the internal
env/config primitive path, not a hidden CLI flag. The old runtime can remain
compiled in, but the selector must only honor the internal gate at the runtime
dispatch boundary.

## When Staging Is Required

Use staged rollout for:

- Protocol changes or capability negotiation changes.
- Runtime swaps, compatibility adapters, or fallback paths.
- Agent mode additions, mode visibility changes, or cross-model dispatch.
- New CLI commands, new command groups, or behavior-changing flags.
- Breaking config changes or migrations with user-visible fallout.

Staging is usually unnecessary for:

- Pure bug fixes with no new behavior.
- Internal refactors that preserve public contracts.
- Docs-only changes.
- Single-tenant experiments that are already isolated by a tenant feature flag.

## Promotion Rules

Promotion to visible behavior should be a small PR that flips visibility or
default selection after the primitive has evidence. Include one paragraph in the
PR body with the evidence used for promotion: internal usage, telemetry, support
exercise, CI coverage, or rollout results.

Every long-lived hidden external surface must have an owner and one of:

- a target promotion version,
- a target removal version, or
- an `indefinite-internal` label with rationale.

Track every hidden flag, hidden mode, protocol capability, and internal gate in
`docs/CONVENTIONS/staged-rollout-registry.json`. Registry entries must include an
owner, current status, promotion/removal target, rationale, and telemetry event
for hidden flags, hidden modes, and internal gates.

`scripts/check-staged-rollout.mjs` validates the registry and, in pull-request
CI, requires a staged-rollout answer in the PR body when risky surfaces change.

## PR Checklist Prompt

For PRs that add or promote user-visible behavior, answer:

> Did this need staged rollout? If not, why is direct exposure safe?

For PRs that add internal cutover controls, also answer:

> Is the control implemented as an internal env/config primitive rather than an
> external CLI/help surface?
