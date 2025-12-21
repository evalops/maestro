# Determinism Boundaries (Clock, RNG, Env)

Audience: contributors working on context assembly, retries, timeouts, and other agent-critical paths.

Composer aims to be deterministic and debuggable. The easiest way to preserve that is to isolate sources of nondeterminism and inject them where needed, instead of calling them directly throughout the codebase.

## Core Idea

Centralize access to time, randomness, and environment configuration:

- **Clock**: use `src/utils/clock.ts` and pass a `Clock` into helpers/managers.
- **RNG**: avoid `Math.random()` or ad-hoc UUID generation in core logic; centralize RNG where practical.
- **Env**: parse environment once at module boundaries and pass config down rather than reading `process.env` inside hot paths.

## Why This Matters

- **Reproducibility**: same inputs, same outputs.
- **Testability**: no sleeps, no wall-clock flakiness.
- **Diagnostics**: easier to replay failures with controlled clocks.

## Clock Pattern

### 1) Accept a clock parameter with a default

```ts
import { systemClock, type Clock } from "../utils/clock.js";

export function sleep(ms: number, clock: Clock = systemClock): Promise<void> {
	return new Promise((resolve) => clock.setTimeout(resolve, ms));
}
```

### 2) Thread the clock through managers

```ts
interface AgentContextOptions {
	clock?: Clock;
}

this.options = {
	clock: options.clock ?? systemClock,
};
```

### 3) In tests, freeze or control time

Use `vi.useFakeTimers()` + `vi.setSystemTime()` or pass a stub clock so no test relies on wall clock.

## RNG Pattern

- Prefer a single RNG boundary for core logic.
- If you need deterministic tests, pass a seeded RNG or stub the RNG boundary.

## Env Pattern

- Parse `process.env` once into config objects.
- For tests, use `vi.stubEnv()` and `vi.resetModules()` to ensure clean config reads.

## Applies To

- `src/agent/context-manager.ts` (clock injected for timing).
- `src/utils/async.ts` (clock-aware sleep/timeout helpers).
- New context sources and retry logic.
