# Headless Protocol Versioning

Maestro headless protocol changes should be staged so native and hosted clients
can recover during a cutover without exposing internal-only commands as public
CLI surface.

## Internal Runtime Cutover Gate

Legacy runtime selection is an internal deployment control, not a CLI command or
support flag. Release automation may set the internal runtime gate during a
cutover window, but user-facing commands must keep the normal headless shape:
`maestro --headless` or `maestro exec --mode=headless`.

The internal gate is only honored when Maestro is already dispatching headless
mode. When present, Maestro selects the previous headless runtime adapter for the
cutover window and emits one info-level log event:

```text
runtime_legacy_selected
```

The event context includes the selected runtime id, the internal source, and the
`headless` surface so cutover usage can be measured without adding a settings
key or another public command. The selected runtime object is also passed into
the headless dispatch boundary; while no cutover is active it resolves to the
current TypeScript adapter, and the next cutover can attach the concrete previous
adapter behind that same selector.

## Cutover Rules

1. Keep the current and previous headless runtime adapters in the same release
   during a protocol cutover.
2. Route the internal runtime gate to the previous adapter until clients have
   upgraded.
3. Do not add cutover controls to CLI help, onboarding docs, or stable
   automation examples.
4. Remove the previous adapter and the internal gate after the cutover window
   closes.

When no protocol cutover is active, the selected legacy runtime id remains a
measurement and routing seam for the TypeScript headless adapter. The next
protocol cutover should register the concrete previous adapter behind the same
selection path instead of introducing a user-facing switch.
