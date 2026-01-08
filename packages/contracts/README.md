# @evalops/contracts

Shared TypeScript definitions for Composer's frontend/backend contract.

## Building locally

```bash
bun install
bun run --filter @evalops/contracts build
```

The package emits ESM + declaration artifacts into `packages/contracts/dist`. Root builds (`npm run build` or `npm run build:all`) automatically invoke this step via TypeScript project references.

## Usage

```ts
import type { ComposerMessage, ComposerUsage } from "@evalops/contracts";

const payload: ComposerMessage = {
	role: "user",
	content: "Hello Composer",
};

const usage: ComposerUsage = {
	input: 1200,
	output: 300,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0.01, output: 0.02, total: 0.03 },
};

payload.usage = usage;
```

## Runtime validation

Contracts also ship lightweight runtime schemas and validators for boundary checks:

```ts
import {
  ComposerChatRequestSchema,
  assertComposerChatRequest,
} from "@evalops/contracts";

assertComposerChatRequest(payload);
```

Consumers outside the monorepo can depend on `@evalops/contracts` once the package has been built/published; only the compiled `dist` folder is distributed.
