import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("telemetry beacon normalization", () => {
	let tempDir: string;
	let beaconFile: string;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-beacon-normalization-"));
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

	it("swallows normalization errors when emitting beacon batches", async () => {
		const { emitBeaconBatch } = await import("../../src/telemetry/beacon.js");

		await emitBeaconBatch([
			{
				feature: "cli.startup",
				action: "interactive",
				timestamp: 1,
				source: {
					client: "cli",
					clientVersion: "0.10.18",
				},
				parameters: {
					metadata: "invalid" as unknown as Record<string, unknown>,
				},
			},
		]);

		await expect(readFile(beaconFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
