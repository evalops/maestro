import { describe, expect, it } from "vitest";

import {
	defaultSmokeTimeoutMs,
	describeSpawnSyncError,
	resolveSmokeTimeoutMs,
} from "../../scripts/smoke-exec-replay-e2e.js";

describe("smoke exec replay e2e script", () => {
	it("uses a longer default timeout on CI runners", () => {
		expect(defaultSmokeTimeoutMs({})).toBe(60_000);
		expect(defaultSmokeTimeoutMs({ CI: "true" })).toBe(120_000);
		expect(defaultSmokeTimeoutMs({ CI: "false" })).toBe(60_000);
		expect(defaultSmokeTimeoutMs({ GITHUB_ACTIONS: "true" })).toBe(120_000);
	});

	it("allows the smoke timeout to be overridden explicitly", () => {
		expect(
			resolveSmokeTimeoutMs({
				MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS: "180000",
			}),
		).toBe(180_000);
	});

	it("rejects invalid smoke timeout overrides", () => {
		expect(() =>
			resolveSmokeTimeoutMs({
				MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS: "120000ms",
			}),
		).toThrow(
			"MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS must be a positive integer",
		);
		expect(() =>
			resolveSmokeTimeoutMs({
				MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS: "0",
			}),
		).toThrow(
			"MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS must be a positive integer",
		);
	});

	it("reports child process timeouts with captured output", () => {
		const error = Object.assign(new Error("spawnSync node ETIMEDOUT"), {
			code: "ETIMEDOUT",
		});
		const failure = describeSpawnSyncError(
			"exec-replay-text",
			{
				error,
				status: null,
				signal: "SIGTERM",
				stdout: "partial stdout",
				stderr: "partial stderr",
			},
			120_000,
		);

		expect(failure.message).toBe("exec-replay-text timed out after 120000ms.");
		expect(failure.message).not.toContain("failed to launch");
		expect(failure.details).toContain("signal: SIGTERM");
		expect(failure.details).toContain("stdout:\npartial stdout");
		expect(failure.details).toContain("stderr:\npartial stderr");
	});
});
