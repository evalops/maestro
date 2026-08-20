# Maestro update lifecycle

The native `maestro update` command records update attempts and exposes the
evidence that is available for the installed artifact. The lifecycle is
deliberately conservative: package-manager installs can update, but they do
not advertise a package-manager rollback path.

## Commands

```text
maestro update status [--channel stable|beta|alpha] [--json]
maestro update history [--json]
maestro update rollback [version] [--json]
maestro update [--channel stable|beta|alpha] [--check] [--json]
```

`status` reports the active/current/latest versions, install method, selected
update source, release notes and signed release receipt when present, the last
attempt and error, retry timing, and the installed native receipt. A failed
network check is represented in `checkError`; it does not erase the persisted
attempt history.

`history` stores at most 32 attempts in `update-history.json`. Native release
installs keep this file under `MAESTRO_DATA_DIR`; package installs and
unclassified native binaries use the Maestro home directory. Writes are
atomic. An attempt is written as `started` before installation, so an
interrupted process remains visible instead of being reported as success.
Each attempt records whether it was triggered by `startup` or `manual` work;
retry timing is reported only for startup-triggered attempts because explicit
manual failures are never silently throttled on a later startup.
If installation or rollback succeeds but completion history cannot be written,
the command still reports the applied version and surfaces the bookkeeping
error separately in machine-readable output.

`rollback` is available only for a native release installation. The target
must be an older retained release with an install receipt whose manifest,
Cosign signature, and artifact checksums were verified. If the release carries
the optional signed metadata asset, its checksum must also verify. The command
verifies the retained binary and web archive again, then atomically replaces
the stable launcher. The retained release directory, bundled web assets,
verified web archive, data directory, and startup-state path are preserved. The
web tree is rebuilt from the verified archive when extracted assets are missing
or damaged. If launcher replacement fails before the rename, the prior startup
state is restored. If the launcher was replaced but its parent-directory
durability sync fails, rollback remains active and `launcherWarning` reports the
durability warning instead of undoing the rollback.
Rollback also persists an explicit startup suppression for newer versions, so
the next automatic launch cannot immediately undo the user’s rollback. A
subsequent manual update clears that suppression.

An unsigned or legacy release may continue to install when explicitly allowed
by the installer fixture contract, but its receipt is not rollback-eligible.
No package-manager rollback is claimed because npm/Bun do not provide a
reliable, receipt-preserving native release switch.

## Release metadata and channels

The signed internal release workflow emits `release-metadata.json`, includes
it in `SHA256SUMS`, and signs the checksum manifest. The metadata contains
release notes only when they exist in the versioned changelog, plus the
runtime-passport receipts produced by the same release job. The updater and
installer surface those fields without synthesizing provenance. Older or
public signed artifact sets without this optional asset remain installable
after their manifest, signatures, binary, and web archive verify; their
receipts leave release metadata unavailable.

Native release updates select the stable channel by default. Stable and
alpha/beta manifests are published as `channel-manifest.json` assets on the
public GitHub releases and verified with the Ed25519 public keys embedded in
the updater. Stable updates first fetch the signed manifest through GitHub's
`releases/latest/download` redirect and use the Releases API only as a
bounded recovery path; beta and alpha discovery use the Releases API. A
legacy GCS channel pointer is accepted only when an operator explicitly supplies `MAESTRO_UPDATE_URL` or
`MAESTRO_UPDATE_URLS`; it is never included in the default source list.
Stable accepts versions without a prerelease suffix. Alpha and beta require
matching prerelease suffixes.

The channel selection and publication contract is in
[`release-channels.json`](./release-channels.json), with operational details
in [`release-channels.md`](./release-channels.md). The updater reports the
selected channel, key ID, signature algorithm, manifest URL, and migration
fallback state in `status --json`.

Stable has no automatic migration fallback to the existing `version.json`
source. An explicitly configured legacy pointer is retained in

Alpha tracks the current public `main` commit; beta uses its parent commit.
Beta uses the next patch line and alpha the following patch line, with a
monotonically increasing prerelease ordinal. Public channel releases publish
immutable version tags and npm `alpha` and `beta` dist-tags.
`MAESTRO_INSTALL_CHANNEL` persists the selected channel as
`MAESTRO_UPDATE_CHANNEL` in native launchers. Package-manager updates install
the exact version advertised by the selected npm dist-tag.

The machine-readable field contract is in
[`update-lifecycle.json`](./update-lifecycle.json).

The source-only contract check is `npm run check:update-lifecycle`. It is kept
out of the aggregate `npm run check` because the public mirror intentionally
does not carry this internal protocol document or the internal release
workflow that the check validates.
