# Release channels

Native release updates and standalone downloads use the same three signed
channel manifests. The public release repository is the canonical pointer
source:

```text
release list  https://api.github.com/repos/evalops/maestro/releases
asset        channel-manifest.json
```

Each manifest uses `evalops.maestro.release-channel.v1` and an Ed25519
signature. The signature covers the canonical JSON object after removing the
`signature` field and sorting object keys recursively. The signed fields
include the channel, key ID, version, release tag, release URL, metadata URL,
metadata digest, source SHA, publication time, release notes, and the release
receipt when the release job produced one.

The updater and installer select the newest non-draft GitHub release whose
immutable tag matches the requested channel, then verify that release's
`channel-manifest.json` before downloading its artifacts. A pointer or release
URL is never accepted solely because it is reachable. During migration,
`MAESTRO_CHANNEL_MANIFEST_URL` or `MAESTRO_CHANNEL_POINTER_BASE` may explicitly
provide a legacy signed pointer; those overrides are not required for normal
public downloads.

The updater embeds one stable public key and one prerelease public key. Alpha
and beta use the prerelease key; the manifest signature binds the channel name.
The key IDs and public keys are recorded in
[`release-channels.json`](./release-channels.json). A key change requires an
updater release that adds the new public key before a manifest uses the new key.
The signing secrets are held by GitHub Actions:

```text
MAESTRO_STABLE_CHANNEL_PRIVATE_KEY
MAESTRO_PREVIEW_CHANNEL_PRIVATE_KEY
```

Stable is the default channel and accepts versions without a semver
prerelease. Legacy GCS pointers are not automatic fallbacks: they are used
only when an operator explicitly configures `MAESTRO_UPDATE_URL` or
`MAESTRO_UPDATE_URLS` (or an installer pointer override). Normal public
resolution never contacts GCS and uses the verified GitHub release manifest.

Alpha requires an `alpha.N` prerelease suffix, and beta requires a `beta.N`
suffix, where N is a positive decimal ordinal. Neither preview channel uses a
cross-channel fallback. After a GitHub discovery or manifest failure, the
updater preserves the verification error and does not silently switch to a
legacy source.

```text
MAESTRO_UPDATE_CHANNEL=stable|beta|alpha
```

`maestro update status --json` reports `channel` and
`channelVerification`. A verified manifest reports `status=verified`, its
`keyId`, `algorithm=ed25519`, and the manifest URL. An explicitly configured
legacy pointer reports `status=legacyFallback` and
`fallback=legacyExplicit`; a failed check retains the verification error.
The apply and history records retain the selected manifest URL in `sourceUrl`.

Package-manager installations retain their npm/Bun update path. The channel
manifest controls native release selection; package-manager rollback remains
unsupported.

## Standalone downloads

The public installer is invoked with bash and persists the selected channel in
the generated launcher:

~~~text
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh \
  | MAESTRO_INSTALL_CHANNEL=beta bash
curl -fsSL https://raw.githubusercontent.com/evalops/maestro/main/scripts/install.sh \
  | MAESTRO_INSTALL_CHANNEL=alpha bash
~~~

Stable, beta, and alpha downloads all verify SHA256SUMS, the native binary,
and the web archive. Preview installs additionally require a channel-bound
version (-beta.N or -alpha.N) and verify the Ed25519 channel manifest before
staging the release. Supplying MAESTRO_INSTALL_VERSION for a different
channel is rejected, and the downloaded binary version must match both the
requested version and the manifest. MAESTRO_ALLOW_UNSIGNED_INSTALL is a
local-test escape hatch; it still enforces the channel, version, release URL,
and manifest schema bindings.

The standalone installer needs bash, curl, awk, base64, tar, and a SHA-256
tool; it does not require Python, Node.js, or OpenSSL. For signed installs it
downloads a checksum-pinned Cosign binary and uses it to verify the raw
Ed25519 channel signature before any release artifact is staged.

An explicit MAESTRO_INSTALL_VERSION may target a historical release that
predates channel-manifest.json. That compatibility path still verifies
SHA256SUMS and Cosign artifacts when present, but
MAESTRO_REQUIRE_SIGNED_INSTALL=1 rejects a pinned release without the
channel manifest; unpinned channel installs always require the manifest.
