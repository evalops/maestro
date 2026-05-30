# Release Surface Conformance

This fixture keeps Maestro's public release path aligned across docs, package
metadata, registry smoke tests, and public mirror automation. It is not a
substitute for publishing a real version, but it catches drift before a release
can silently lose an install or evidence gate.

The executable manifest lives at
[`release-surface-conformance.json`](./release-surface-conformance.json). Run it
with:

```bash
npm run check:release-surface
```

## Covered Surfaces

| Area | What It Guards |
| --- | --- |
| public install docs | README install commands for npm and Bun remain visible and package-specific. |
| package metadata | `@evalops/maestro` stays public, exposes the `maestro` bin, and declares runtime workspaces as vendored metadata. |
| dependency hygiene | Private runtime workspace packages cannot reappear as install-time registry dependencies. |
| registry install smokes | npm, npx, Bun, bunx, and `bunx --bun` runtime paths stay connected to published replay evidence. |
| published replay | text, JSON, and RPC replay modes keep session, tool, ToolExecution, approval, search/ripgrep, error, artifact, final-status, query-index, and AgentRuntime evidence. |
| published replay verifier | The evidence verifier must keep npm and Bun installer coverage, replay modes, ToolExecution checks, queryable observability traces, AgentRuntime lifecycle checks, and the release-gate assertion wired. |
| release readiness | local release gates continue to build, verify runtime deps, pack-smoke, and replay-smoke. |
| tag release | the already-published package path cannot pass on `npm view` alone; it must run npm and Bun registry install smokes plus published replay evidence validation. |
| public mirror | the sanitized public tree, release-helper mirror sync, public-only published verification scripts, mirror contract, and fallback publish workflow keep their guardrails. |

## Completion Bar

The conformance fixture proves that the expected release artifacts and gates are
still wired. A release is only proven after the actual workflow publishes the
package, a fresh npm and Bun install succeeds, published replay evidence is
archived, and any intentionally broken historical release has been deprecated
when npm auth permits.
