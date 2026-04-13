import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as featureFlags from "../../src/config/feature-flags.js";
import * as magicDocs from "../../src/server/automations/magic-docs.js";
import * as scheduler from "../../src/server/automations/scheduler.js";
import {
	handleAutomationMagicDocs,
	handleAutomations,
} from "../../src/server/handlers/automations.js";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

function makeReq(
	url: string,
	options: { method?: string } = {},
): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = options.method ?? "GET";
	req.url = url;
	req.headers = { host: "localhost" };
	return req;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
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
}

describe("handleAutomationMagicDocs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the discovered Magic Docs template", async () => {
		vi.spyOn(magicDocs, "buildMagicDocsAutomationTemplate").mockReturnValue({
			magicDocs: [
				{
					path: "docs/architecture.md",
					title: "Architecture",
					instructions: "Track decisions.",
				},
			],
			template: {
				name: "Magic Docs Sync",
				prompt: "Update the docs",
				contextPaths: ["docs/architecture.md"],
			},
		});

		const req = makeReq("/api/automations/magic-docs");
		const res = makeRes();

		await handleAutomationMagicDocs(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{ corsHeaders } as never,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			magicDocs: [
				{
					path: "docs/architecture.md",
					title: "Architecture",
					instructions: "Track decisions.",
				},
			],
			template: {
				name: "Magic Docs Sync",
				prompt: "Update the docs",
				contextPaths: ["docs/architecture.md"],
			},
		});
	});

	it("rejects unsupported methods", async () => {
		const req = makeReq("/api/automations/magic-docs", { method: "POST" });
		const res = makeRes();

		await handleAutomationMagicDocs(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{ corsHeaders } as never,
		);

		expect(res.statusCode).toBe(405);
		expect(JSON.parse(res.body)).toEqual({
			error: "Method not allowed",
		});
	});
});

describe("handleAutomations", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 503 when autonomous actions are disabled", async () => {
		vi.spyOn(featureFlags, "areAutonomousActionsDisabled").mockReturnValue(
			true,
		);
		const runSpy = vi.spyOn(scheduler, "runAutomationById");

		const req = makeReq("/api/automations/automation-1/run", {
			method: "POST",
		});
		const res = makeRes();

		await handleAutomations(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			{ corsHeaders } as never,
			{ id: "automation-1" },
		);

		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body)).toEqual({
			error: "service_disabled",
			message: "Autonomous actions are temporarily disabled",
		});
		expect(runSpy).not.toHaveBeenCalled();
	});
});
