# Deixic Code naming and compatibility

Deixic Code is the canonical customer-facing name for Deixic's native coding
agent. Maestro remains an internal runtime and compatibility identifier; it is
not a separate product brand and is not another name for the Dex persona.

## Compatibility matrix

| Surface | Canonical surface | Retained Maestro alias or identifier | Deprecation status | Migration boundary |
| --- | --- | --- | --- | --- |
| Product and UI name | Deixic Code | Maestro in compatibility explanations | Customer-facing use deprecated now | New copy uses Deixic Code; historical and machine-readable references stay unchanged. |
| Command | `deixic-code` | `maestro` | Supported compatibility alias; no removal date | Installers and npm packages expose both commands over the same native binary. |
| npm package | `@evalops/deixic-code` | `@evalops/maestro` | Legacy package remains supported during dual publication | Source and public-mirror metadata are ready for the canonical package; npm trusted publishing must be configured before the first canonical publish. |
| Public repository | `evalops/maestro` | `evalops/maestro` URL | Current release coordinate | Release and download links continue to use the existing repository. |
| Native binary, crates, and release assets | Deixic Code distribution | `maestro`, `maestro-tui`, `maestro-runtime-gateway`, and `maestro-*` assets | Retained compatibility identifiers | No flag-day rename. The canonical launcher delegates to the existing native binary. |
| Configuration and local data | Deixic Code settings shown in product copy | `MAESTRO_*`, `~/.maestro`, `.maestro` | Retained compatibility contract | Existing installs, automation, and persisted sessions continue without migration. |
| Protocols, schemas, events, and receipts | Deixic Code in human-readable descriptions | `maestro.v1`, `evalops.maestro.*`, Maestro event subjects and IDs | Retained compatibility contract | Identifiers and wire values do not change; only source-owned display text changes. |
| IDE plugin | Deixic Code display name | `com.evalops.composer`, `Maestro` tool-window and notification IDs | Retained compatibility IDs | Marketplace copy and visible actions use Deixic Code; stable lookup IDs do not change. |

## Publication cutover

This repository keeps `@evalops/maestro` as its source-package coordinate and
sets `@evalops/deixic-code` as the canonical public projection. The release
source must publish the same native payload under both package names during
the migration. Do not deprecate the Maestro package or remove its `maestro`
command until a separately reviewed compatibility policy supplies a date and
usage evidence.

The existing `evalops/maestro` repository remains the release and download
coordinate.

## Internal language

Architecture documentation may say “Deixic Code runtime
(internally/compatibly Maestro)” when both concepts matter. Protocol packages,
schema names, environment variables, persisted paths, telemetry keys, release
assets, historical documents, and migration fixtures should continue using
their exact Maestro identifiers.
