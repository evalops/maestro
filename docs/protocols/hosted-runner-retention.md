# Hosted Runner Retention

Hosted Maestro runners write a local drain manifest so Platform can decide what
to upload, how long to keep it, and when to delete it. This document is the
Maestro-side contract for that handoff.

Maestro does not hardcode account retention windows. Platform and deploy own
the actual external storage durations, deletion jobs, and provider-specific
cleanup. Maestro owns the local artifact shape, the visibility classes, and the
set of things that must never leave the live runtime in plaintext.

## Data Classes

| Data class | Examples | Visibility | Rule |
| --- | --- | --- | --- |
| Control-plane metadata | `runner_session_id`, `workspace_id`, stop reason, timestamps, git summary | `operator` | May persist in Platform/operator systems. Do not include raw credentials, raw env dumps, or artifact access grants. |
| Workspace export | Paths chosen by `export_paths` and the files/directories behind them | `tenant` | May persist as tenant-scoped workspace artifacts. Operator browsing should stay off by default. |
| Runtime snapshot | `manifest.snapshot`, `runtime.session_file`, runtime cursor/state | `internal` | May exist locally in the runtime manifest, but any external copy must stay internal-only or be reduced to a redacted derivative first. |
| Runtime logs | stdout/stderr, headless diagnostics, tool/model traces | `operator` | Persist only after redacting prompts, tool output, secret echoes, provider strings, and other sensitive payloads. |
| Credentials and grants | Provider API keys, attach tokens, artifact access URLs, raw env values | `never persist` | Must be dropped or redacted before any external write. |

## Drain Manifest Policy Block

New hosted drain manifests include a `retention_policy` block with:

- `policy_version`: versioned contract id for the visibility/redaction rules
- `managed_by=platform`: external retention and deletion are Platform-owned
- `visibility`: the allowed audience for each manifest section
- `redaction.required_before_external_persistence`: sections that must not be
  copied out of the live runtime verbatim
- `redaction.forbidden_plaintext`: credential/grant classes that must never be
  written externally in raw form

This block is intentionally small. It gives Platform/deploy a stable policy
handle without forcing Maestro to encode account-specific day counts.

## Lifecycle

1. Maestro writes the local drain manifest under the configured snapshot root.
2. Platform may ingest the manifest and upload selected artifacts.
3. External retention windows are chosen by Platform per account/profile.
4. Platform deletes uploaded artifacts after expiry or explicit cleanup.
5. Provider teardown removes the pod-local manifest and any unuploaded runtime
   files.

Secure or provider-backed profiles do not get a different data model. They must
honor the same visibility classes and redaction rules before reusing the hosted
runner contract.

## Required Rules

- Workspace export metadata stays bounded to the workspace root.
- Runtime snapshots and session files are not tenant-download artifacts.
- Raw runtime logs are not tenant-visible artifacts.
- Credentials, attach tokens, artifact grants, and raw environment captures are
  never valid persisted outputs.
- Any operator-facing derivative of runtime snapshot or log data must be
  redacted before persistence.

## Follow-Through

The manifest policy block is the schema-level contract. Cleanup lifecycle
signals such as deletion succeeded, expiry applied, or cleanup failed should be
tracked separately in runtime/control-plane events rather than inferred from the
manifest file alone. Platform follow-through is tracked in
`evalops/platform#853`.
