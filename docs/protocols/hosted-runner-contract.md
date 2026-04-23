# Hosted Runner Contract

Maestro hosted runners are substrate-neutral runtime pods or sandboxes that
Platform can create, attach to, drain, and stop for an EvalOps account. The
contract is deliberately small: every provider must expose the same Maestro
session surface, even if the provider is GKE, GKE Sandbox, Daytona, Modal, or a
future microVM fleet.

This document is the Maestro-side contract. Platform owns policy, account
entitlements, scheduling profiles, billing, artifact upload, and provider
selection. Maestro owns the runtime process, headless protocol behavior,
workspace enforcement, drain manifest, and session state flush.

## Required Shape

A hosted runner instance represents exactly one logical runner session.

- One `runner_session_id` from Platform.
- One workspace root mounted or created for the session.
- One Maestro HTTP/headless attach surface.
- One optional pre-bound Maestro session id.
- One owner generation when Platform uses stale-owner attach fencing.
- One drain/snapshot location under the workspace unless explicitly mounted
  elsewhere by the provider.

The runtime must not expose provider-specific fields to Maestro clients. Public
clients choose product-level profiles such as `maestro-standard`,
`maestro-spot`, or `maestro-secure`; Platform and deploy translate those
profiles into node pools, RuntimeClasses, sandbox options, or microVM details.

## Configuration

The hosted runner entrypoint is `maestro hosted-runner`. Providers may pass
flags or environment variables, but the resolved values are the contract.

| Contract field | Flags and environment | Required |
| --- | --- | --- |
| Runner session id | `--runner-session-id`, `MAESTRO_RUNNER_SESSION_ID`, `REMOTE_RUNNER_SESSION_ID` | yes |
| Workspace root | `--workspace-root`, `MAESTRO_WORKSPACE_ROOT`, `WORKSPACE_ROOT` | yes |
| Listen address | `--listen`, `--host`, `--port`, `MAESTRO_HOSTED_RUNNER_LISTEN`, `MAESTRO_HOSTED_RUNNER_HOST`, `MAESTRO_HOSTED_RUNNER_PORT`, `PORT` | yes |
| Owner generation | `--owner-instance-id`, `MAESTRO_REMOTE_RUNNER_OWNER_INSTANCE_ID`, `REMOTE_RUNNER_OWNER_INSTANCE_ID` | required when Platform fences owners |
| Snapshot root | `--snapshot-root`, `MAESTRO_REMOTE_RUNNER_SNAPSHOT_ROOT`, `REMOTE_RUNNER_SNAPSHOT_ROOT` | optional |
| Restore manifest | `MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST`, `REMOTE_RUNNER_RESTORE_MANIFEST` | optional |
| Workspace id | `--workspace-id`, `MAESTRO_REMOTE_RUNNER_WORKSPACE_ID`, `MAESTRO_WORKSPACE_ID` | optional |
| Agent run id | `--agent-run-id`, `MAESTRO_AGENT_RUN_ID` | optional |
| Existing Maestro session | `--maestro-session-id`, `MAESTRO_SESSION_ID` | optional |
| Attach audience | `--attach-audience`, `MAESTRO_ATTACH_AUDIENCE` | optional |

Hosted runner startup also sets these runtime defaults before the web server is
imported:

- `MAESTRO_HOSTED_RUNNER_MODE=1`
- `MAESTRO_PROFILE=hosted-runner` unless already set
- `MAESTRO_WEB_REQUIRE_KEY=0`
- `MAESTRO_WEB_REQUIRE_REDIS=0`
- `MAESTRO_WEB_REQUIRE_CSRF=0`
- `MAESTRO_AGENT_DIR=<workspace>/.maestro/agent` unless already set

Those defaults are local runtime defaults, not a public security model.
Platform still owns network access, attach authentication, account policy, and
egress policy.

## Startup And Readiness

A conforming runner must start the Maestro HTTP server only after the workspace
root exists and resolves to a directory. Startup must fail closed when required
identity or workspace fields are missing.

Diagnostics go to stderr or the configured log sink. Protocol stdout must stay
reserved for JSON when the stdio headless transport is used. HTTP handlers must
return structured JSON errors rather than human log text.

Platform should treat the identity endpoint as the readiness gate:

```http
GET /.well-known/evalops/remote-runner/identity
```

The response is intentionally sparse:

```json
{
  "protocol_version": "evalops.remote-runner.identity.v1",
  "runner_session_id": "mrs_123",
  "owner_instance_id": "pod_123",
  "ready": true,
  "draining": false
}
```

`ready=false` or `draining=true` means the gateway must not attach new clients.
If Platform expects an owner generation, it must compare
`owner_instance_id` before proxying attach traffic.

## Attach Surface

All providers expose the same HTTP headless surface:

- `POST /api/headless/connections`
- `POST /api/headless/sessions/:id/subscribe`
- `GET /api/headless/sessions/:id/events`
- `POST /api/headless/sessions/:id/messages`
- `POST /api/headless/sessions/:id/heartbeat`
- `POST /api/headless/sessions/:id/disconnect`
- `GET /api/headless/sessions/:id/state`

Runtimes may keep `/api/headless/sessions/:id/message` as a compatibility
alias, but new Rust and Platform code should use `/messages`.

The event stream is replayable by cursor. Clients that fall behind receive a
reset snapshot. This mirrors the reference remote-session pattern: durable
control session plus reconnectable event stream, rather than a single fragile
socket.

Connections negotiate:

- role: `controller` or `viewer`
- server request capabilities: `approval`, `client_tool`, `mcp_elicitation`,
  `user_input`, `tool_retry`
- utility operations: `command_exec`, `file_search`, `file_read`, `file_watch`
- notification opt-outs: `status`, `heartbeat`, `connection_info`,
  `compaction`

Viewers are read-only. Controllers hold the mutation lease. Controller takeover
must be explicit and visible in heartbeat/subscription snapshots.

## Workspace Rules

The workspace root is the only default file-system authority for hosted utility
operations.

- `utility_file_read` must reject paths outside the workspace root.
- `utility_file_search` must only return workspace-contained paths.
- `utility_file_watch_start` must only watch workspace-contained roots.
- `utility_command_start` must default to the workspace root unless a safe
  workspace-contained cwd is supplied.
- Drain export paths must stay inside the workspace root.

Provider-level file APIs, such as Daytona or Modal filesystem APIs, do not
weaken this contract. They are implementation helpers behind Platform, not
additional Maestro client authority.

## Runtime Lifecycle

The lifecycle is:

1. Platform creates a runner session and selects a provider profile.
2. Provider starts the runtime with the contract configuration.
3. Maestro binds the process to the runner session and workspace root.
4. Platform waits for the identity endpoint to report `ready=true`.
5. Clients attach through Platform's gateway or directly in local development.
6. Platform sends heartbeats and samples usage through its control plane.
7. Platform requests drain before TTL expiry, budget exhaustion, or user stop.
8. Maestro stops active headless work, flushes session state, writes a local
   snapshot manifest, and reports drain status.
9. Platform uploads artifacts if required and terminates the provider instance.
10. If Platform starts a replacement runner from uploaded artifacts, it passes
    the restored local manifest path through the restore-manifest field. Maestro
    validates the manifest against the workspace root, seeds the runtime cursor
    and last snapshot state, emits a `restored_from_snapshot` reset event, and
    accepts fresh controller/viewer attachments only when the runtime flush was
    completed.

Drain uses:

```http
POST /.well-known/evalops/remote-runner/drain
```

The manifest protocol is
`evalops.remote-runner.snapshot-manifest.v1`. Both Rust-hosted and
TypeScript-hosted drain paths write this same local manifest envelope, including
the runtime flush status, workspace export contract, headless runtime snapshot,
and `retention_policy` metadata describing visibility and redaction classes.
Maestro does not upload to GCS, S3, Modal storage, Daytona storage, or any
other provider store. Upload, retention, workspace artifact hydration, and
choosing which manifest should be restored are Platform responsibilities. See
[Hosted Runner Retention](./hosted-runner-retention.md) for the policy rules
that travel with the manifest.

## Rust Hosted Surface

The Rust crate exposes a first hosted-runner library surface through
`maestro_tui::hosted_runner::start_hosted_runner`. It binds a single-session HTTP
runtime for tests and local adapters, exposes the identity/readiness/drain
contract, serves the replayable headless attach endpoints, enforces
workspace-root containment for file, watch, and command utility operations, and
writes the local drain manifest with the requested workspace export paths. It
deliberately keeps provider scheduling and artifact upload out of Rust;
Platform still owns those concerns.

The Rust surface can also start from a previously written snapshot manifest via
`MAESTRO_REMOTE_RUNNER_RESTORE_MANIFEST`, `REMOTE_RUNNER_RESTORE_MANIFEST`, or
`HostedRunnerConfig::with_restore_manifest_path`. Relative paths resolve under
the workspace root. Startup rejects manifests with an unsupported protocol
version or workspace export paths that escape the current workspace. Restore is
a runtime-state seed: it preserves the logical Maestro session id, cursor,
last init, and snapshot state for reconnecting clients, then emits a reset
snapshot with reason `restored_from_snapshot`. Manifests whose
`runtime.flush_status` is `failed` or `skipped` restore into a not-ready
inspection state: identity reports `ready=false`, `/readyz` and attach routes
return `runtime_not_ready`, and the runtime snapshot surfaces the restore
problem in `last_status`, `last_error`, and `last_error_type`. It does not
hydrate files from cloud storage; the provider must mount or download workspace
artifacts before starting Maestro.

The Rust surface now has an opt-in hosted conformance adapter. The adapter
spawns a deterministic fixture binary, attaches over HTTP/SSE, and exercises the
same shared scenarios as the TypeScript in-process host while the Rust server
owns leases, replay, snapshots, workspace utilities, heartbeat, and disconnect
behavior. The required hosted adapter also covers the drain handoff shape:
manifest response, persisted snapshot file, export-path recording, and
post-drain mutation rejection. It is not yet the final `maestro hosted-runner`
CLI wrapper.

## Error Vocabulary

Provider implementations should normalize failures to these categories at the
gateway or attach boundary:

| Error | Retry | Meaning |
| --- | --- | --- |
| `runtime_not_ready` | yes | Provider object exists but identity says not ready or draining. |
| `runtime_proxy_failed` | yes | Gateway could not reach the runtime. |
| `runtime_owned_elsewhere` | no | Identity owner generation does not match the control-plane owner. |
| `runtime_lost` | no | Provider runtime disappeared or became unrecoverable. |
| `runtime_failed` | no | Runtime exited after an infrastructure or startup failure. |
| `runtime_exited` | no | Runtime exited cleanly or after user stop. |
| `access_denied` | no | Attach auth, audience, account, or role is invalid. |
| `workspace_violation` | no | A requested path escapes the hosted workspace root. |
| `unsupported_capability` | no | Client negotiated a capability this runner does not provide. |
| `drain_timeout` | maybe | Drain did not complete before the provider grace window. |

Retryable HTTP failures should use `503` and `Retry-After` where they pass
through HTTP. Permanent authorization and owner failures should not be retried
without a fresh attach token or a new runtime owner.

## Provider Notes

These notes are intentionally non-contractual. They describe useful provider
primitives without leaking them into Maestro's public runtime shape.

### GKE Standard And Spot

GKE pods are the default self-operated profile because they match Platform's
existing control-plane model: one Kubernetes object per runner session, native
status reconciliation, service routing, resource requests, taints, and
tolerations.

Use stable profile ids at the Platform boundary. Keep node selectors,
tolerations, Spot settings, and node-pool names in deploy/Platform. Kubernetes
recommends node isolation labels that kubelets cannot modify; labels protected
by the `node-restriction.kubernetes.io/` prefix are the right pattern for
security-sensitive scheduling.

### GKE Sandbox

The secure profile can run the same Maestro contract with `RuntimeClass=gvisor`
on a GKE Sandbox node pool. GKE Sandbox applies the `sandbox.gke.io/runtime:
gvisor` label and matching taint to capable nodes, and pods using the `gvisor`
RuntimeClass receive the corresponding scheduling rules.

Use this when defense-in-depth matters more than raw syscall compatibility or
performance. Do not make `gvisor` part of Maestro client input; expose it only
as a resolved profile property.

### GKE Workload Identity Federation

Runner pods should avoid long-lived cloud keys. GKE Workload Identity
Federation lets Kubernetes identities authenticate to Google Cloud APIs through
IAM policies for specific namespaces or service accounts. Platform can use that
for artifact upload, image pulls, or telemetry exporters without handing cloud
keys to Maestro.

### Daytona

Daytona sandboxes provide isolated computers with lifecycle APIs for create,
start, list, stop, archive, recover, resize, delete, labels, resources, and
public HTTP previews. A Daytona provider can map Platform runner metadata to
sandbox labels, start Maestro inside the sandbox, and expose the hosted runner
port through a private or public preview URL.

The Maestro contract stays the same: the sandbox preview points to the same
identity, drain, and headless endpoints.

### Modal

Modal Sandboxes are useful for provider-managed ephemeral environments. The API
has readiness probes, tunnels by container port, connect tokens, process exec,
filesystem APIs, file watching, termination, polling, and directory snapshots.

A Modal provider can use readiness probes for the identity endpoint, tunnels or
connect tokens for attach routing, and `snapshot_directory` as an implementation
detail after Maestro writes its local drain manifest.

### Firecracker

Firecracker can be a future isolation substrate, especially if cold-start and
snapshot restore are important. Its snapshot support can serialize and later
restore a running microVM workload. That is powerful but should stay behind a
provider adapter until Maestro has a runtime identity, secret rotation, network
proxy, workspace mount, and drain/resume story that preserves session
uniqueness after restore.

Do not make clients choose Firecracker directly. Treat it as a backend for a
profile such as `maestro-secure` or `maestro-fast-restore` after Platform owns
the operational model.

## Conformance

Every hosted runner implementation should satisfy the shared conformance suite:

```bash
npm run test -- test/headless/runtime-conformance.test.ts
```

Rust hosted-runner wire parity is enforced by the dedicated
`rust-hosted-conformance` CI job. Run the same gate locally with:

```bash
MAESTRO_RUST_HOSTED_CONFORMANCE=1 npm run test -- test/headless/runtime-conformance.test.ts
```

Current coverage includes schema-valid snapshots/envelopes, controller/viewer
roles, explicit controller takeover, cursor replay/reset, approval request and
response resolution, workspace-root file-read enforcement, utility
command/search/watch lifecycle, and disconnect cleanup.

The TypeScript adapter targets the in-process host. The Rust-hosted adapter
drives the same scenarios through
`maestro_tui::hosted_runner::start_hosted_runner_with_message_executor` and the
external HTTP/SSE surface. The scenario body must remain shared; only adapter
startup and transport details should vary.

## References

- [Headless protocol reference](./headless.md)
- [Headless runtime conformance](./headless-conformance.md)
- [Hosted runner retention](./hosted-runner-retention.md)
- [Kubernetes node isolation and NodeRestriction](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#node-isolation-restriction)
- [GKE Sandbox with gVisor](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods)
- [GKE Workload Identity Federation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes/)
- [Modal sandboxes](https://modal.com/docs/guide/sandboxes)
- [Modal Sandbox reference](https://modal.com/docs/reference/modal.Sandbox)
- [Firecracker snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
