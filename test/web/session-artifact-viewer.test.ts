import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueArtifactAccessGrant } from "../../src/server/artifact-access.js";

const mockLoadSession = vi.fn();

vi.mock("../../src/server/session-scope.js", () => ({
	createSessionManagerForRequest: vi.fn(() => ({
		loadSession: mockLoadSession,
	})),
	resolveSessionScope: vi.fn(() => "scope-1"),
}));

vi.mock("../../src/server/session-serialization.js", () => ({
	convertAppMessagesToComposer: vi.fn((messages: unknown[]) => messages),
}));

import { handleSessionArtifactViewer } from "../../src/server/handlers/session-artifacts.js";

function createMockRequest(url: string, token: string): IncomingMessage {
	return {
		method: "GET",
		url,
		headers: {
			"x-composer-artifact-access": token,
		},
	} as IncomingMessage;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getBody: () => string;
} {
	let status = 200;
	let body = "";

	const res = {
		writeHead: vi.fn((nextStatus: number) => {
			status = nextStatus;
		}),
		setHeader: vi.fn(),
		end: vi.fn((chunk?: string | Buffer) => {
			body =
				typeof chunk === "string"
					? chunk
					: Buffer.isBuffer(chunk)
						? chunk.toString("utf8")
						: "";
		}),
	} as unknown as ServerResponse;

	return {
		res,
		getStatus: () => status,
		getBody: () => body,
	};
}

describe("session artifact viewer auth", () => {
	beforeEach(() => {
		mockLoadSession.mockResolvedValue({
			messages: [
				{
					role: "assistant",
					content: "",
					tools: [
						{
							id: "tool-1",
							name: "artifacts",
							status: "completed",
							args: {
								command: "create",
								filename: "preview.html",
								content: "<html><body>preview</body></html>",
							},
							result: { ok: true },
						},
					],
				},
			],
		});
	});

	it("does not embed artifact access tokens into viewer action urls", async () => {
		const access = issueArtifactAccessGrant({
			sessionId: "session-1",
			scope: "scope-1",
			filename: "preview.html",
			actions: ["view", "file", "events", "zip"],
		});
		const req = createMockRequest(
			"/api/sessions/session-1/artifacts/preview.html/view",
			access.token,
		);
		const response = createMockResponse();

		await handleSessionArtifactViewer(
			req,
			response.res,
			{ id: "session-1", filename: "preview.html" },
			{ "Access-Control-Allow-Origin": "*" },
		);

		expect(response.getStatus()).toBe(200);
		expect(response.getBody()).toContain("Download ZIP");
		expect(response.getBody()).toContain("x-composer-artifact-access");
		expect(response.getBody()).not.toContain("composerArtifactToken=");
	});
});
