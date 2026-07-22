import { describe, expect, it } from "vitest";
import {
	createNativeMemoryNoopCoordinators,
	noopAutomaticMemoryConsolidation,
	noopAutomaticMemoryExtraction,
} from "../../src/server/native-memory-noop.js";

describe("native-memory-noop", () => {
	it("exports no-op extraction and consolidation coordinators", async () => {
		noopAutomaticMemoryExtraction.schedule("/tmp/session.jsonl");
		noopAutomaticMemoryConsolidation.schedule();
		await expect(
			noopAutomaticMemoryExtraction.flush(),
		).resolves.toBeUndefined();
		await expect(
			noopAutomaticMemoryConsolidation.flush(),
		).resolves.toBeUndefined();
	});

	it("createNativeMemoryNoopCoordinators returns the shared no-ops", async () => {
		const pair = createNativeMemoryNoopCoordinators();
		expect(pair.extraction).toBe(noopAutomaticMemoryExtraction);
		expect(pair.consolidation).toBe(noopAutomaticMemoryConsolidation);
		pair.extraction.schedule(null);
		pair.consolidation.schedule();
		await pair.extraction.flush();
		await pair.consolidation.flush();
	});
});
