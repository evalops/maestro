import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("telemetry beacon", () => {
	let tempDir: string;
	let beaconFile: string;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-beacon-"));
		beaconFile = join(tempDir, "beacon.jsonl");
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_BEACON_FILE", beaconFile);
		vi.stubEnv("MAESTRO_OTEL", "0");
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("writes normalized safe and sensitive metadata as a pre-session batch", async () => {
		const { emitBeacon } = await import("../../src/telemetry/beacon.js");

		await emitBeacon({
			feature: "cli.startup",
			action: "interactive",
			timestamp: 1_772_000_000_000_000,
			source: {
				client: "cli",
				clientVersion: "0.10.18",
				surface: "cli",
			},
			parameters: {
				metadata: {
					command: "interactive",
					apiKey: "sk-test1234567890abcd",
					summary: "token=sk-test1234567890abcd",
				},
				sensitiveMetadata: {
					cookie: "session=secret-cookie",
				},
			},
		});

		const [event] = JSON.parse((await readFile(beaconFile, "utf8")).trim()) as [
			{
				parameters?: {
					metadata?: Record<string, unknown>;
					sensitiveMetadata?: Record<string, unknown>;
				};
			},
		];

		expect(event.parameters?.metadata).toEqual({
			command: "interactive",
			summary: "token=[secret]",
		});
		expect(event.parameters?.sensitiveMetadata).toEqual({
			apiKey: "[sensitive]",
			cookie: "[sensitive]",
		});
	});

	it("preserves overlapping nested sensitive metadata from both inputs", async () => {
		const { emitBeacon } = await import("../../src/telemetry/beacon.js");

		await emitBeacon({
			feature: "cli.startup",
			action: "interactive",
			timestamp: 1_772_000_000_000_000,
			source: {
				client: "cli",
				clientVersion: "0.10.18",
				surface: "cli",
			},
			parameters: {
				metadata: {
					headers: {
						authorization: "Bearer sk-test1234567890abcd",
					},
					items: [
						{
							token: "sk-item1234567890abcd",
						},
					],
				},
				sensitiveMetadata: {
					headers: {
						cookie: "session=secret-cookie",
					},
					items: [
						{
							cookie: "session=item-cookie",
						},
					],
				},
			},
		});

		const [event] = JSON.parse((await readFile(beaconFile, "utf8")).trim()) as [
			{
				parameters?: {
					sensitiveMetadata?: Record<string, unknown>;
				};
			},
		];

		expect(event.parameters?.sensitiveMetadata).toEqual({
			headers: {
				authorization: "[sensitive]",
				cookie: "[sensitive]",
			},
			items: [
				{
					token: "[sensitive]",
					cookie: "[sensitive]",
				},
			],
		});
	});

	it("respects telemetry opt-out for beacon files", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY", "0");
		const { emitBeacon } = await import("../../src/telemetry/beacon.js");

		await emitBeacon({
			feature: "cli.startup",
			action: "interactive",
			timestamp: 1,
			source: {
				client: "cli",
				clientVersion: "0.10.18",
			},
		});

		await expect(readFile(beaconFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("posts beacon batches to the configured endpoint with API-key auth", async () => {
		vi.stubEnv("MAESTRO_BEACON_ENDPOINT", "https://telemetry.example.test");
		vi.stubEnv("MAESTRO_BEACON_API_KEY", "beacon-key");
		const fetchFn = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);
		const { emitBeaconBatch } = await import("../../src/telemetry/beacon.js");

		await emitBeaconBatch(
			[
				{
					feature: "cli.command",
					action: "cli.command.run",
					timestamp: 1,
					source: {
						client: "cli",
						clientVersion: "0.10.18",
					},
					parameters: {
						metadata: {
							count: 2,
						},
					},
				},
			],
			{ fetchFn },
		);

		expect(fetchFn).toHaveBeenCalledWith(
			"https://telemetry.example.test",
			expect.objectContaining({
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer beacon-key",
				},
				body: expect.stringContaining("cli.command.run"),
			}),
		);
	});

	it("does not reuse the primary API key for endpoint auth", async () => {
		vi.stubEnv("MAESTRO_BEACON_ENDPOINT", "https://telemetry.example.test");
		vi.stubEnv("MAESTRO_API_KEY", "primary-key");
		const fetchFn = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 204 })),
		);
		const { emitBeacon } = await import("../../src/telemetry/beacon.js");

		await emitBeacon(
			{
				feature: "cli.startup",
				action: "interactive",
				timestamp: 1,
				source: {
					client: "cli",
					clientVersion: "0.10.18",
				},
			},
			{ fetchFn },
		);

		expect(fetchFn).toHaveBeenCalledWith(
			"https://telemetry.example.test",
			expect.objectContaining({
				headers: {
					"content-type": "application/json",
				},
			}),
		);
	});

	it("reports endpoint emission failure for unsuccessful HTTP responses", async () => {
		vi.stubEnv("MAESTRO_BEACON_FILE", "");
		vi.stubEnv("MAESTRO_BEACON_ENDPOINT", "https://telemetry.example.test");
		const fetchFn = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 500 })),
		);
		const { emitBeacon } = await import("../../src/telemetry/beacon.js");

		await expect(
			emitBeacon(
				{
					feature: "cli.startup",
					action: "interactive",
					timestamp: 1,
					source: {
						client: "cli",
						clientVersion: "0.10.18",
					},
				},
				{ fetchFn },
			),
		).resolves.toBe(false);
	});
});
