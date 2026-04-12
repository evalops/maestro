# @evalops/contracts

Shared TypeScript definitions for Maestro's frontend/backend contract.

## Building locally

```bash
bun install
bun run --filter @evalops/contracts build
```

The package emits ESM + declaration artifacts into `packages/contracts/dist`.
Its build now regenerates the checked-in headless protocol artifacts first, so
changes to the protocol manifest stay aligned with the generated TS and Rust
surfaces.

Root builds (`npm run build` or `npm run build:all`) also run the same headless
protocol codegen step before TypeScript compilation, so local builds do not rely
on a separate manual generation command.

The repository also now carries a bootstrap protobuf schema for the headless
protocol at `proto/maestro/v1/headless.proto`. Buf generation writes the
checked-in TypeScript descriptors to
`packages/contracts/src/proto/maestro/v1/headless_pb.ts`, and the package root
re-exports those generated schemas for follow-up transport and multi-language
work. This slice does not replace the live JSON protocol yet; it establishes the
protobuf source of truth alongside the existing runtime surface.

## Usage

```ts
import type { MaestroMessage, MaestroUsage } from "@evalops/contracts";

const payload: MaestroMessage = {
	role: "user",
	content: "Hello Maestro",
};

const usage: MaestroUsage = {
	input: 1200,
	output: 300,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0.01, output: 0.02, total: 0.03 },
};

payload.usage = usage;
```

## Streaming events

`MaestroAgentEvent` models the wire events emitted by Maestro's streaming
endpoints, including transport signals like `session_update`, `heartbeat`,
`aborted`, and `done`.

## Runtime validation

Contracts also ship lightweight runtime schemas and validators for boundary checks:

```ts
import {
  MaestroChatRequestSchema,
  assertMaestroChatRequest,
} from "@evalops/contracts";

assertMaestroChatRequest(payload);
```

Consumers outside the monorepo can depend on `@evalops/contracts` once the package has been built/published; only the compiled `dist` folder is distributed.
