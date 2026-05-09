# Headless Protocol Versioning

Maestro headless protocol changes should be staged so native and hosted clients
can recover during a cutover without exposing internal-only commands as public
CLI surface.

## Runtime Escape Flag

`--legacy-runtime` is a hidden support flag for headless protocol cutovers. It
is intentionally omitted from default `maestro --help`; support staff can verify
its presence with:

```bash
maestro --help --hidden
```

The flag is only valid with `--headless` or `--mode headless`. When present,
Maestro selects the previous headless runtime adapter for the cutover window and
emits one info-level log event:

```text
runtime_legacy_selected
```

The event context includes the selected runtime id, the triggering flag, and the
`headless` surface so cutover usage can be measured without adding a settings
key or another public command. The selected runtime object is also passed into
the headless dispatch boundary; while no cutover is active it resolves to the
current TypeScript adapter, and the next cutover can attach the concrete previous
adapter behind that same selector.

## Cutover Rules

1. Keep the current and previous headless runtime adapters in the same release
   during a protocol cutover.
2. Route `--legacy-runtime` to the previous adapter until clients have upgraded.
3. Mention the flag in cutover release notes only. Do not add it to default
   help, onboarding docs, or stable automation examples.
4. Remove the previous adapter and the escape flag after the cutover window
   closes.

When no protocol cutover is active, the selected legacy runtime id remains a
measurement and routing seam for the TypeScript headless adapter. The next
protocol cutover should register the concrete previous adapter behind the same
selection path instead of introducing another flag.
