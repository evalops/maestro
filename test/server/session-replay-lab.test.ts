import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/session/types.js";

function createMockRequest(): IncomingMessage {
	return {
		method: "GET",
		headers: {},
		socket: { remoteAddress: "127.0.0.1" },
	} as unknown as IncomingMessage;
}

describe("session replay lab", () => {
	afterEach(() => {
		vi.doUnmock("../../src/server/session-scope.js");
		vi.resetModules();
	});

	it("loads hosted DB session entries through the session manager", async () => {
		const entries: SessionEntry[] = [
			{
				type: "session",
				version: 2,
				id: "hosted-session",
				timestamp: "2026-05-22T12:00:00.000Z",
				cwd: "/tmp/maestro",
			},
			{
				type: "custom",
				id: "entry-approval",
				parentId: null,
				timestamp: "2026-05-22T12:00:01.000Z",
				customType: "approval.completed",
				data: { approved: true },
			},
		];
		const hostedManager = {
			storageKind: "database",
			loadSession: vi.fn(async () => ({
				id: "hosted-session",
				owner: "anon",
				createdAt: "2026-05-22T12:00:00.000Z",
				updatedAt: "2026-05-22T12:00:01.000Z",
				messageCount: 0,
				messages: [],
			})),
			loadEntries: vi.fn(async () => entries),
			getSessionFileById: vi.fn(() => "db:hosted-session"),
		};
		vi.doMock("../../src/server/session-scope.js", () => ({
			createWebSessionManagerForRequest: vi.fn(() => hostedManager),
		}));

		const { buildSessionReplayLabForRequest } = await import(
			"../../src/server/handlers/session-replay-lab.js"
		);
		const report = await buildSessionReplayLabForRequest(createMockRequest(), {
			id: "hosted-session",
		});

		expect(hostedManager.loadEntries).toHaveBeenCalledWith("hosted-session");
		expect(hostedManager.getSessionFileById).not.toHaveBeenCalled();
		expect(report.timeline.items.map((item) => item.type)).toContain(
			"session.started",
		);
		expect(report.timeline.items.map((item) => item.type)).toContain(
			"custom.event",
		);
	});
});
