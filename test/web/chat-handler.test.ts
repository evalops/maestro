import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RegisteredModel } from "../../src/models/registry.js";
import { handleChat } from "../../src/web/handlers/chat.js";

const mockModel: RegisteredModel = {
	id: "claude-sonnet-4-5",
	provider: "anthropic",
	name: "Claude",
	api: "chat",
};

const cors = { "Access-Control-Allow-Origin": "*" };

function makeRes() {
	const res: any = {
		statusCode: 200,
		headers: {} as Record<string, string>,
		body: "",
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
	return res;
}

describe("handleChat", () => {
	it("returns 400 when no messages supplied", async () => {
		const req = new PassThrough() as any;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(JSON.stringify({ messages: [] }));

		const res = makeRes();

		await handleChat(req, res, cors, {
			createAgent: async () => {
				throw new Error("should not create agent");
			},
			getRegisteredModel: async () => mockModel,
			defaultApprovalMode: "prompt",
			defaultProvider: "anthropic",
			defaultModelId: mockModel.id,
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("No messages supplied");
	});
});
