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

import {
	addMemory,
	exportMemories,
	getRecentMemories,
	getStats,
	getTopicMemories,
	searchMemories,
} from "../../src/memory/index.js";
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

	it("passes session id filters through read actions", async () => {
		const req = {
			method: "GET",
			headers: { host: "localhost" },
			url: "/api/memory?action=list&topic=session-memory&sessionId=sess_123",
		} as IncomingMessage;
		const res = {} as ServerResponse;

		await handleMemory(req, res, {});

		expect(getTopicMemories).toHaveBeenCalledWith("session-memory", {
			sessionId: "sess_123",
		});
	});

	it("passes session id through search, recent, and stats actions", async () => {
		const res = {} as ServerResponse;

		await handleMemory(
			{
				method: "GET",
				headers: { host: "localhost" },
				url: "/api/memory?action=search&query=REST&sessionId=sess_123&limit=5",
			} as IncomingMessage,
			res,
			{},
		);
		expect(searchMemories).toHaveBeenCalledWith("REST", {
			limit: 5,
			sessionId: "sess_123",
		});

		await handleMemory(
			{
				method: "GET",
				headers: { host: "localhost" },
				url: "/api/memory?action=recent&sessionId=sess_123&limit=3",
			} as IncomingMessage,
			res,
			{},
		);
		expect(getRecentMemories).toHaveBeenCalledWith(3, {
			sessionId: "sess_123",
		});

		await handleMemory(
			{
				method: "GET",
				headers: { host: "localhost" },
				url: "/api/memory?action=stats&sessionId=sess_123",
			} as IncomingMessage,
			res,
			{},
		);
		expect(getStats).toHaveBeenCalledWith({
			sessionId: "sess_123",
		});
	});

	it("passes session id through save actions", async () => {
		vi.mocked(readJsonBody).mockResolvedValue({
			action: "save",
			topic: "api-design",
			content: "Use REST conventions",
			tags: ["rest"],
			sessionId: "sess_123",
		});
		const req = {
			method: "POST",
			headers: { host: "localhost" },
			url: "/api/memory",
		} as IncomingMessage;
		const res = {} as ServerResponse;

		await handleMemory(req, res, {});

		expect(addMemory).toHaveBeenCalledWith(
			"api-design",
			"Use REST conventions",
			{
				cwd: process.cwd(),
				tags: ["rest"],
				sessionId: "sess_123",
			},
		);
	});
});
