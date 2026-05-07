import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("telemetry metadata split", () => {
	let tempDir: string;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-telemetry-"));
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_TELEMETRY_FILE", join(tempDir, "telemetry.jsonl"));
		vi.stubEnv("MAESTRO_OTEL", "0");
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("routes sensitive metadata keys out of queryable metadata", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T09:00:00.000Z",
			toolName: "bash",
			success: true,
			durationMs: 25,
			metadata: {
				sessionId: "session-123",
				agentRunId: "run-456",
				commandSummary: "npm test -- token=sk-test1234567890abcd",
				apiKey: "sk-test1234567890abcd",
				password: "correct-horse-battery-staple",
				headers: {
					authorization: "Bearer secret-token",
					route: "/v1/runs",
				},
			},
		});

		const payload = JSON.parse(
			(await readFile(join(tempDir, "telemetry.jsonl"), "utf8")).trim(),
		) as {
			metadata?: Record<string, unknown>;
			sensitiveMetadata?: Record<string, unknown>;
		};

		expect(payload.metadata).toEqual({
			sessionId: "session-123",
			agentRunId: "run-456",
			commandSummary: "npm test -- token=[secret]",
			headers: {
				route: "/v1/runs",
			},
		});
		expect(payload.sensitiveMetadata).toEqual({
			apiKey: "[sensitive]",
			password: "[sensitive]",
			headers: {
				authorization: "[sensitive]",
			},
		});
		expect(JSON.stringify(payload.metadata)).not.toContain("correct-horse");
		expect(JSON.stringify(payload.metadata)).not.toContain("sk-test");
	});

	it("mirrors normalized metadata to the Maestro event bus", async () => {
		const mirrorTelemetryToMaestroEventBus = vi.fn(() => Promise.resolve());
		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			mirrorTelemetryToMaestroEventBus,
			resolveMaestroEventBusConfig: () => ({
				defaultCorrelation: {},
				defaultPrincipal: undefined,
				defaultSurface: "cli",
			}),
		}));

		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T09:00:01.000Z",
			toolName: "bash",
			success: false,
			durationMs: 40,
			metadata: {
				agentRunId: "run-789",
				error: "request failed with Authorization: Bearer secret-token",
				headers: {
					authorization: "Bearer secret-token",
					route: "/v1/runs",
				},
			},
			sensitiveMetadata: {
				headers: {
					cookie: "session=secret-cookie",
				},
			},
		});

		expect(mirrorTelemetryToMaestroEventBus).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: {
					agentRunId: "run-789",
					error: "request failed with Authorization: Bearer [secret]",
					headers: {
						route: "/v1/runs",
					},
				},
				sensitiveMetadata: {
					headers: {
						authorization: "[sensitive]",
						cookie: "[sensitive]",
					},
				},
			}),
		);
	});

	it("preserves sensitive fields when overlapping arrays are merged", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T09:00:02.000Z",
			toolName: "bash",
			success: true,
			durationMs: 18,
			metadata: {
				events: [
					{ name: "first", token: "secret-token" },
					{ apiKey: "sk-test1234567890abcd" },
				],
			},
			sensitiveMetadata: {
				events: [{ cookie: "session=secret-cookie" }, null, { password: "pw" }],
			},
		});

		const payload = JSON.parse(
			(await readFile(join(tempDir, "telemetry.jsonl"), "utf8")).trim(),
		) as {
			metadata?: Record<string, unknown>;
			sensitiveMetadata?: Record<string, unknown>;
		};

		expect(payload.metadata).toEqual({
			events: [{ name: "first" }, null],
		});
		expect(payload.sensitiveMetadata).toEqual({
			events: [
				{ token: "[sensitive]", cookie: "[sensitive]" },
				{ apiKey: "[sensitive]" },
				{ password: "[sensitive]" },
			],
		});
	});

	it("keeps telemetry recording safe when metadata contains cycles", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");
		const metadata: Record<string, unknown> = {
			sessionId: "session-cycle",
		};
		metadata.self = metadata;

		await expect(
			recordTelemetry({
				type: "tool-execution",
				timestamp: "2026-05-07T09:00:03.000Z",
				toolName: "bash",
				success: true,
				durationMs: 10,
				metadata,
			}),
		).resolves.toBeUndefined();

		const payload = JSON.parse(
			(await readFile(join(tempDir, "telemetry.jsonl"), "utf8")).trim(),
		) as {
			metadata?: Record<string, unknown>;
		};

		expect(payload.metadata).toEqual({
			sessionId: "session-cycle",
			self: "[circular]",
		});
	});

	it("preserves non-plain metadata objects with their JSON representation", async () => {
		const { recordTelemetry } = await import("../../src/telemetry.js");

		await recordTelemetry({
			type: "tool-execution",
			timestamp: "2026-05-07T09:00:04.000Z",
			toolName: "bash",
			success: true,
			durationMs: 12,
			metadata: {
				generatedAt: new Date("2026-05-07T09:00:04.000Z"),
				dashboardUrl: new URL("https://example.test/runs/run-123"),
			},
		});

		const payload = JSON.parse(
			(await readFile(join(tempDir, "telemetry.jsonl"), "utf8")).trim(),
		) as {
			metadata?: Record<string, unknown>;
		};

		expect(payload.metadata).toEqual({
			generatedAt: "2026-05-07T09:00:04.000Z",
			dashboardUrl: "https://example.test/runs/run-123",
		});
	});

	it("classifies nested metadata without losing safe sibling fields", async () => {
		const { splitTelemetryMetadata } = await import("../../src/telemetry.js");

		expect(
			splitTelemetryMetadata({
				workspaceId: "workspace-1",
				nested: {
					token: "secret-token",
					count: 2,
				},
				events: [
					{ name: "safe", token: "secret-token" },
					{ name: "also-safe" },
				],
			}),
		).toEqual({
			metadata: {
				workspaceId: "workspace-1",
				nested: {
					count: 2,
				},
				events: [{ name: "safe" }, { name: "also-safe" }],
			},
			sensitiveMetadata: {
				nested: {
					token: "[sensitive]",
				},
				events: [{ token: "[sensitive]" }, null],
			},
		});
	});
});
