# @evalops/consumer

Unified EvalOps consumer SDK for applications that need Maestro service clients without wiring each service separately.

```ts
import { EvalOpsClient } from "@evalops/consumer";

const evalops = EvalOpsClient.fromEnv({
	featureFlags: {
		kestrel: true,
	},
});

const profile = await evalops.identity.getProfile();
const route = await evalops.llmGateway.route({
	taskType: "code-review",
	workspaceId: "workspace_123",
	modelHints: ["gpt-5.4"],
});
```

## Configuration

`EvalOpsClient` accepts explicit configuration or reads environment variables:

- `EVALOPS_BASE_URL`: API base URL. Defaults to `https://api.evalops.dev`.
- `EVALOPS_TOKEN`: bearer token used for all service calls.

```ts
const evalops = new EvalOpsClient({
	baseUrl: "https://api.evalops.example",
	token: process.env.EVALOPS_TOKEN,
	cacheTtlMs: 30_000,
	cacheMaxEntries: 500,
	featureFlags: {
		connectorsOAuth: true,
	},
});
```

The client adds `Authorization: Bearer <token>` when a token is configured and caches read-style calls for 30 seconds by default. Expired entries are pruned on cacheable requests, and the in-memory cache keeps the 500 most recently used entries unless `cacheMaxEntries` is overridden.

## Service Clients

`EvalOpsClient` exposes typed clients for:

- `llmGateway`
- `meter`
- `approvals`
- `memory`
- `traces`
- `agentRegistry`
- `skills`
- `identity`
- `governance`
- `connectors`

The SDK re-exports `@evalops/contracts`, so generated proto contract types can be imported from the same package:

```ts
import type { ComposerMessage } from "@evalops/consumer";
```

## Offline Fallbacks

Offline fallback is enabled by default. When a downstream call fails and the service method has a fallback response, the SDK returns a typed fallback payload and records metrics.

```ts
const connectors = await evalops.connectors.list();
const metrics = evalops.getMetrics();

if (connectors.offline) {
	console.log(metrics.lastFallback);
}
```

Disable fallback by passing `offlineFallback: false`.
