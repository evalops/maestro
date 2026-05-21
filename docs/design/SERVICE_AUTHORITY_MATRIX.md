# Service Authority Matrix

Maestro can run as a local/offline agent runtime, but enterprise state belongs
to Platform when Platform is configured. The service authority matrix makes that
boundary executable instead of relying on handler-specific convention.

The contract lives in `src/services/service-authority.ts` and uses
`evalops.maestro.service-authority.v1`.

## Runtime Modes

- `platform_authoritative`: reads and writes go to Platform. Maestro may keep a
  local cache only when the descriptor allows it.
- `platform_unavailable`: Platform owns reads and writes, but no Platform
  endpoint is configured and the service does not allow a Maestro local fallback.
- `offline_adapter`: Maestro reads and writes local state because Platform is
  unavailable or standalone/offline mode was requested.

Set `MAESTRO_PLATFORM_BASE_URL` to prefer Platform ownership. Set
`MAESTRO_STANDALONE=1`, `MAESTRO_OFFLINE=1`, or
`MAESTRO_<SERVICE>_AUTHORITY=offline` to force the local adapter only for
services that explicitly allow local fallback. Services without local fallback,
such as `revenue_attribution`, stay Platform-owned and resolve to
`platform_unavailable` instead of silently routing to Maestro. Use
`MAESTRO_<SERVICE>_AUTHORITY=platform` for smoke tests that need Platform
authority without a full environment.

## Tracked Services

| Service | Platform primitive | Local role |
| --- | --- | --- |
| `workspace_config` | `WorkspacePolicy` | offline adapter |
| `governance` | `GovernancePolicy` | offline adapter |
| `approvals` | `ApprovalRequest` | offline adapter |
| `traces` | `MaestroTimeline` | cache |
| `usage_analytics` | `UsageMeter` | cache |
| `intelligent_router` | `ModelRouter` | offline adapter |
| `revenue_attribution` | `RevenueAttribution` | cache |
| `compliance` | `ComplianceEvidence` | offline adapter |

New service code should expose `getAuthority()` and branch on the resolved mode
before adding a local database table or in-memory singleton. Local-only services
must be described as offline adapters or caches, not as a second enterprise
source of truth.
