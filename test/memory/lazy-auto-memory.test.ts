import { describe, expect, it, vi } from "vitest";
import { createLazyAutoMemoryCoordinators } from "../../src/memory/lazy-auto-memory.js";

function createOptions() {
	const extraction = {
		schedule: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
	};
	const consolidation = {
		schedule: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
	};
	const createBackgroundTextAgent = vi.fn(() => ({ kind: "agent" }));
	const loaders = {
		loadBackgroundAgent: vi
			.fn()
			.mockResolvedValue({ createBackgroundTextAgent }),
		loadAutoConsolidation: vi.fn().mockResolvedValue({
			createAutomaticMemoryConsolidationCoordinator: vi.fn(() => consolidation),
			getMemoryConsolidationSystemPrompt: vi.fn(() => "consolidate"),
		}),
		loadAutoExtraction: vi.fn().mockResolvedValue({
			createAutomaticMemoryExtractionCoordinator: vi.fn(() => extraction),
			getMemoryExtractionSystemPrompt: vi.fn(() => "extract"),
		}),
	};
	const options = {
		cwd: "/repo",
		getAuthContext: vi.fn(),
		getModel: vi.fn(() => ({ id: "model", api: "anthropic" }) as never),
		sessionManager: {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			flush: vi.fn().mockResolvedValue(undefined),
			saveSessionMemoryExtractionHash: vi.fn(),
		},
		loaders,
	};
	return { consolidation, extraction, loaders, options };
}

describe("createLazyAutoMemoryCoordinators", () => {
	it("does not load automatic memory modules until scheduled", async () => {
		const { loaders, options } = createOptions();
		const lazyMemory = createLazyAutoMemoryCoordinators(options);

		await lazyMemory.flush();

		expect(loaders.loadBackgroundAgent).not.toHaveBeenCalled();
		expect(loaders.loadAutoConsolidation).not.toHaveBeenCalled();
		expect(loaders.loadAutoExtraction).not.toHaveBeenCalled();
	});

	it("drains pending extraction schedules and flushes both coordinators", async () => {
		const { consolidation, extraction, loaders, options } = createOptions();
		const lazyMemory = createLazyAutoMemoryCoordinators(options);

		lazyMemory.extraction.schedule("/tmp/session-a.jsonl");
		lazyMemory.extraction.schedule("/tmp/session-b.jsonl");
		await lazyMemory.flush();

		expect(loaders.loadBackgroundAgent).toHaveBeenCalledTimes(1);
		expect(loaders.loadAutoConsolidation).toHaveBeenCalledTimes(1);
		expect(loaders.loadAutoExtraction).toHaveBeenCalledTimes(1);
		expect(extraction.schedule).toHaveBeenCalledWith("/tmp/session-a.jsonl");
		expect(extraction.schedule).toHaveBeenCalledWith("/tmp/session-b.jsonl");
		expect(extraction.flush).toHaveBeenCalledTimes(1);
		expect(consolidation.flush).toHaveBeenCalledTimes(1);
	});
});
