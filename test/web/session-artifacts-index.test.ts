import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadSession = vi.fn();

vi.mock("../../src/server/session-scope.js", () => ({
	createWebSessionManagerForRequest: vi.fn(() => ({
		loadSession: mockLoadSession,
	})),
	resolveSessionScope: vi.fn(() => "scope-1"),
}));

vi.mock("../../src/server/session-serialization.js", () => ({
	convertAppMessagesToComposer: vi.fn((messages: unknown[]) => messages),
}));

import {
	handleSessionArtifactsIndex,
	handleSessionArtifactsZip,
} from "../../src/server/handlers/session-artifacts.js";

function makeReq(url: string): IncomingMessage {
	return {
		method: "GET",
		url,
		headers: {},
	} as IncomingMessage;
}

function makeRes(): {
	res: ServerResponse;
	getStatus: () => number;
	getBody: () => Buffer;
} {
	let status = 200;
	const chunks: Buffer[] = [];

	const res = {
		writeHead: vi.fn((nextStatus: number) => {
			status = nextStatus;
		}),
		end: vi.fn((chunk?: string | Buffer | Uint8Array) => {
			if (chunk === undefined) return;
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}),
		writableEnded: false,
		headersSent: false,
	} as unknown as ServerResponse;

	return {
		res,
		getStatus: () => status,
		getBody: () => Buffer.concat(chunks),
	};
}

describe("session artifacts index", () => {
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
								filename: "../secret.txt",
								content: "hidden",
							},
							result: { ok: true },
						},
						{
							id: "tool-2",
							name: "artifacts",
							status: "completed",
							args: {
								command: "create",
								filename: "nested/report.txt",
								content: "hidden",
							},
							result: { ok: true },
						},
						{
							id: "tool-3",
							name: "artifacts",
							status: "completed",
							args: {
								command: "create",
								filename: "report.txt",
								content: "visible",
							},
							result: { ok: true },
						},
					],
				},
			],
		});
	});

	it("filters unsafe persisted artifact filenames from the index", async () => {
		const response = makeRes();

		await handleSessionArtifactsIndex(
			makeReq("/api/sessions/session-1/artifacts"),
			response.res,
			{ id: "session-1" },
			{ "Access-Control-Allow-Origin": "*" },
		);

		expect(response.getStatus()).toBe(200);
		expect(JSON.parse(response.getBody().toString("utf8"))).toEqual({
			sessionId: "session-1",
			filenames: ["report.txt"],
		});
	});

	it("filters unsafe persisted artifact filenames from zip exports", async () => {
		const response = makeRes();

		await handleSessionArtifactsZip(
			makeReq("/api/sessions/session-1/artifacts.zip"),
			response.res,
			{ id: "session-1" },
			{ "Access-Control-Allow-Origin": "*" },
		);

		const zip = response.getBody();
		expect(response.getStatus()).toBe(200);
		expect(zip.includes(Buffer.from("report.txt"))).toBe(true);
		expect(zip.includes(Buffer.from("../secret.txt"))).toBe(false);
		expect(zip.includes(Buffer.from("nested/report.txt"))).toBe(false);
	});
});
