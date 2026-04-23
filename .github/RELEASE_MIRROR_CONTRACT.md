# Release Mirror Contract

The release mirror manifest is the narrow list of files that must stay
byte-for-byte compatible between `evalops/maestro-internal` and
`evalops/maestro`. It is intentionally smaller than the public release mirror:
only shared release infrastructure and public runtime surfaces belong here.

## Rules

- Add a file to `.github/release-mirror-manifest.json` only when public and
  internal should share that file exactly.
- Keep internal wiring out of the manifest. Split shared logic into a mirrored
  module first, then keep the internal adapter outside the manifest.
- Land public-facing runtime changes in `evalops/maestro-internal` first. The
  `sync-public-release-mirror` workflow keeps the narrow manifest synchronized
  on push, and can prepare the sanitized public tree in manual `public-tree`
  mode once public-only work has been migrated back into internal.
- Use direct public-first changes only for emergency release recovery, then
  backport them to internal before the next mirror sync.
- Remove a file from the manifest when the repos need intentional divergence.
  Do not paper over divergence by changing `scripts/sync-release-mirror.mjs`.

## Command Registry Boundary

The mirrored command registry surface is the flat catalog, adapter, command
suite runtime, subcommand definitions, and the TUI command-suite wiring. These
files travel together because partial mirroring recreates the old grouped
handler split and leaves one repo with a different command model.

The following surfaces are intentionally internal-only and must not be added to
the manifest:

- `src/cli-tui/tui-renderer.ts`
- `src/cli-tui/commands/grouped-command-handlers.ts`
- `src/cli-tui/tui-renderer/grouped-handlers-wiring.ts`
- `src/cli-tui/commands/grouped/**`

## Maestro Event Catalog Boundary

The mirrored event catalog is the no-transport contract in
`src/telemetry/maestro-event-catalog.ts`. It declares Maestro event subjects,
protobuf schema IDs, Any type URLs, and the platform consumer IDs expected by
the shared platform `maestro.*` subscriber catalog.

Keep NATS/JetStream publisher code outside this manifest unless both repos
intentionally own the same transport behavior. Internal can consume the catalog
before it adopts the public event-bus publisher.

## Local Checks

From `maestro-internal`, with a public `evalops/maestro` checkout available:

```sh
node scripts/check-release-mirror-contract.mjs
node scripts/sync-release-mirror.mjs --check --source "$PWD" --target /path/to/evalops/maestro
```

CI runs both checks in the `public-release-mirror` job.
