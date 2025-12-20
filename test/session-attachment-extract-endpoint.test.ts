import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tempDir: string | null = null;
let sessionFilePath = "";
let loadedSession: unknown = null;

vi.mock("../src/session/manager.js", () => ({
	SessionManager: vi.fn().mockImplementation(() => ({
		loadSession: vi.fn().mockImplementation(async () => loadedSession),
		getSessionFileById: vi.fn().mockImplementation(() => sessionFilePath),
		saveAttachmentExtraction: vi
			.fn()
			.mockImplementation(
				(_path: string, attachmentId: string, text: string) => {
					const line = JSON.stringify({
						type: "attachment_extract",
						timestamp: new Date().toISOString(),
						attachmentId,
						extractedText: text,
					});
					const existing = readFileSync(sessionFilePath, "utf8");
					writeFileSync(sessionFilePath, `${existing}${line}\n`, "utf8");
				},
			),
	})),
}));

import { handleSessionAttachmentExtract } from "../src/server/handlers/session-attachments.js";

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
	sessionFilePath = "";
	loadedSession = null;
	vi.restoreAllMocks();
});

function createMockRequest(url: string): IncomingMessage {
	return { method: "POST", url, headers: {} } as unknown as IncomingMessage;
}

function createMockResponse(): {
	res: ServerResponse;
	getStatus: () => number;
	getJson: () => unknown;
} {
	let status = 0;
	let body: string | null = null;

	const res = {
		writeHead: vi.fn((s: number) => {
			status = s;
		}),
		end: vi.fn((b?: string | Buffer) => {
			if (typeof b === "string") body = b;
			else if (b instanceof Buffer) body = b.toString("utf8");
		}),
	} as unknown as ServerResponse;

	return {
		res,
		getStatus: () => status,
		getJson: () => (body ? (JSON.parse(body) as unknown) : null),
	};
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

describe("Session Attachment Extract Endpoint", () => {
	it("extracts text and persists extractedText into the session file", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "composer-session-extract-"));
		sessionFilePath = join(tempDir, "session.jsonl");

		const base64 = Buffer.from("hello", "utf8").toString("base64");
		const initial = [
			JSON.stringify({
				type: "session",
				id: "test-session-1",
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					attachments: [
						{
							id: "att-1",
							fileName: "hello.txt",
							mimeType: "text/plain",
							content: base64,
						},
					],
				},
			}),
		].join("\n");
		writeFileSync(sessionFilePath, `${initial}\n`, "utf8");

		loadedSession = {
			id: "test-session-1",
			messages: [
				{
					role: "user",
					attachments: [
						{
							id: "att-1",
							fileName: "hello.txt",
							mimeType: "text/plain",
							content: base64,
						},
					],
				},
			],
		};

		const req = createMockRequest(
			"/api/sessions/test-session-1/attachments/att-1/extract",
		);
		const { res, getStatus, getJson } = createMockResponse();

		await handleSessionAttachmentExtract(
			req,
			res,
			{ id: "test-session-1", attachmentId: "att-1" },
			corsHeaders,
		);

		expect(getStatus()).toBe(200);
		const json = getJson() as { extractedText?: string };
		expect(json.extractedText).toBe("hello");

		const updated = readFileSync(sessionFilePath, "utf8");
		expect(updated).toContain('"type":"attachment_extract"');
		expect(updated).toContain('"extractedText":"hello"');
	});
});
