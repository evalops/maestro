import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleStatus } from "../../src/server/handlers/status.js";

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
	options: { method?: string; body?: unknown } = {},
): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = options.method ?? "GET";
	req.url = url;
	req.headers = { host: "localhost" };
	if (options.body !== undefined) {
		req.end(JSON.stringify(options.body));
	}
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
			if (chunk) {
				this.write(chunk);
			}
			this.writableEnded = true;
		},
	};
}

describe("handleStatus", () => {
	let tempRoot: string;
	let originalCwd: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-status-handler-"));
		originalCwd = process.cwd();
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
		process.chdir(tempRoot);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("includes project onboarding data in status snapshots", () => {
		writeFileSync(join(tempRoot, "package.json"), "{}");

		const req = makeReq("/api/status");
		const res = makeRes();

		handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			cwd: process.cwd(),
			onboarding: {
				shouldShow: true,
				completed: false,
				seenCount: 0,
				steps: [
					{
						key: "workspace",
						isComplete: true,
						isEnabled: false,
					},
					{
						key: "instructions",
						isComplete: false,
						isEnabled: true,
					},
				],
			},
		});
	});

	it("records onboarding impressions through the status action endpoint", () => {
		writeFileSync(join(tempRoot, "package.json"), "{}");
		mkdirSync(join(tempRoot, ".maestro"), { recursive: true });

		const markReq = makeReq("/api/status?action=mark-onboarding-seen", {
			method: "POST",
		});
		const markRes = makeRes();

		handleStatus(
			markReq as unknown as IncomingMessage,
			markRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(markRes.statusCode).toBe(200);
		expect(JSON.parse(markRes.body)).toEqual({ success: true });

		const statusReq = makeReq("/api/status");
		const statusRes = makeRes();
		handleStatus(
			statusReq as unknown as IncomingMessage,
			statusRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(JSON.parse(statusRes.body)).toMatchObject({
			onboarding: {
				seenCount: 1,
				shouldShow: true,
			},
		});
	});
});
