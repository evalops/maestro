# Secure session transfer

Maestro keeps the existing `maestro-session-export.v1` JSON/JSONL format for
local, human-readable workflows. For moving a session family between trusted
installations, use the explicit `secure-json` format:

```sh
maestro sessions export <session-id> session.secure.json \
  --format secure-json \
  --encryption-key-file /secure/path/recipient.key \
  --signing-key-file /secure/path/signer.pk8 \
  --recipient-key-id workstation-a \
  --signing-key-id operator-2026-08
```

The import side must select the same recipient key out of band and a trusted
Ed25519 public key:

```sh
maestro sessions import session.secure.json \
  --encryption-key-file /secure/path/recipient.key \
  --verify-key-file /secure/path/signer.pub \
  --recipient-key-id workstation-a
```

The machine-readable contract is
[`secure-session-transfer.json`](./secure-session-transfer.json).

## Security boundary

Secure export always applies Maestro’s portable credential redactor before the
payload is serialized and encrypted. The bundle contains no private key,
recipient key bytes, server URL, or key-custody reference. Key files are
operator-managed and are never generated, uploaded, persisted in Maestro state,
or recovered from a remote service. The encryption key is exactly 32 raw bytes;
the signing key is an Ed25519 PKCS#8 private key; the verification key is 32 raw
Ed25519 public-key bytes. The encryption key and signing private-key files must
not be group- or world-readable on Unix.

The envelope uses AES-256-GCM for confidentiality and payload integrity and
Ed25519 for provenance. The signature covers the canonical envelope (including
the ciphertext) under a domain-separated contract. Import validates bounded
metadata, verifies the signature, authenticates/decrypts the payload, validates
the legacy v1 payload, and only then writes session files. Tampering, truncation,
wrong keys, unknown fields, unsupported algorithms, and mismatched recipient
IDs fail closed without creating imported sessions.

Every envelope carries a UUID `bundleId` and RFC3339 `issuedAt`. Verified imports
copy the bundle ID into the imported session header as `portableBundleId`. A
replayed verified bundle is therefore auditable and safe: session-ID collisions
are rewritten, no tools execute during import, and import has no side effects
beyond writing the session files.

## Compatibility

Existing `json` and `jsonl` export/import behavior remains available. Secure
imports are never silently treated as plaintext. A secure envelope requires
both explicit key files; a legacy v1 bundle requires none. The secure envelope
is bounded to 16 MiB and rejects unknown fields so future versions must be
introduced under a new format identifier with an explicit migration rule.
