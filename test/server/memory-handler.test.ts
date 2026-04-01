import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/memory/index.js", () => ({
	addMemory: vi.fn(),
	clearAllMemories: vi.fn(),
	deleteMemory: vi.fn(),
	deleteTopicMemories: vi.fn(),
	exportMemories: vi.fn(() => ({ entries: [] })),
	getRecentMemories: vi.fn(),
	getStats: vi.fn(),
	getTopicMemories: vi.fn(),
	importMemories: vi.fn(),
	listTopics: vi.fn(),
	searchMemories: vi.fn(),
}));

vi.mock("../../src/server/server-utils.js", () => ({
	readJsonBody: vi.fn(),
	respondWithApiError: vi.fn(),
	sendJson: vi.fn(),
}));

import { exportMemories } from "../../src/memory/index.js";
import { handleMemory } from "../../src/server/handlers/memory.js";
import { readJsonBody, sendJson } from "../../src/server/server-utils.js";

describe("handleMemory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(exportMemories).mockReturnValue({ entries: [] });
	});

	it("uses a maestro filename when exporting without an explicit path", async () => {
		vi.mocked(readJsonBody).mockResolvedValue({ action: "export" });
		const req = {
			method: "POST",
			headers: { host: "localhost" },
			url: "/api/memory",
		} as IncomingMessage;
		const res = {} as ServerResponse;

		await handleMemory(req, res, {});

		expect(sendJson).toHaveBeenCalledWith(
			res,
			200,
			expect.objectContaining({
				success: true,
				path: expect.stringContaining("maestro-memories.json"),
			}),
			{},
		);
		expect(sendJson).not.toHaveBeenCalledWith(
			res,
			200,
			expect.objectContaining({
				path: expect.stringContaining("composer-memories.json"),
			}),
			{},
		);
	});
});
