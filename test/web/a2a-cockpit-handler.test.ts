import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildA2ACockpit } from "../../src/platform/a2a-cockpit.js";
import { handleA2ACockpit } from "../../src/server/handlers/a2a-cockpit.js";
import { resolveSessionScope } from "../../src/server/session-scope.js";

vi.mock("../../src/platform/a2a-cockpit.js", () => ({
	buildA2ACockpit: vi.fn(),
}));
vi.mock("../../src/server/session-scope.js", () => ({
	resolveSessionScope: vi.fn(),
}));

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string | number>;
	body: string;
	writableEnded: boolean;
	writeHead(status: number, headers?: Record<string, string | number>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

describe("handleA2ACockpit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveSessionScope).mockReturnValue(null);
	});

	it("builds the cockpit from hosted-safe query options", async () => {
		vi.mocked(buildA2ACockpit).mockResolvedValueOnce({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			counts: {
				peers: 0,
				onlinePeers: 0,
				unreachablePeers: 0,
				tasks: 0,
				runningTasks: 0,
				actionRequiredTasks: 0,
				failedTasks: 0,
				completedTasks: 0,
			},
			peers: [],
			tasks: [],
			nextActions: [],
		});
		const req = makeReq(
			"/api/a2a/cockpit?timeoutMs=1234&peer=mac-mini&limit=3",
		);
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).toHaveBeenCalledWith({
			registryPath: undefined,
			tasksPath: undefined,
			timeoutMs: 1234,
			peer: "mac-mini",
			limit: 3,
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			registryPath: "/tmp/peers.json",
			nextActions: [],
		});
	});

	it("scopes hosted cockpit storage to the authenticated session scope", async () => {
		vi.mocked(resolveSessionScope).mockReturnValue("workspace:one/user:two");
		vi.mocked(buildA2ACockpit).mockResolvedValueOnce({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath:
				"/Users/test/.maestro/a2a/scopes/workspace_one_user_two/peers.json",
			tasksPath:
				"/Users/test/.maestro/a2a/scopes/workspace_one_user_two/tasks.json",
			counts: {
				peers: 0,
				onlinePeers: 0,
				unreachablePeers: 0,
				tasks: 0,
				runningTasks: 0,
				actionRequiredTasks: 0,
				failedTasks: 0,
				completedTasks: 0,
			},
			peers: [],
			tasks: [],
			nextActions: [],
		});
		const req = makeReq("/api/a2a/cockpit?limit=2");
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).toHaveBeenCalledWith({
			registryPath: expect.stringMatching(
				/[/\\]\.maestro[/\\]a2a[/\\]scopes[/\\]workspace_one_user_two[/\\]peers\.json$/,
			),
			tasksPath: expect.stringMatching(
				/[/\\]\.maestro[/\\]a2a[/\\]scopes[/\\]workspace_one_user_two[/\\]tasks\.json$/,
			),
			timeoutMs: 2500,
			peer: undefined,
			limit: 2,
		});
		expect(res.statusCode).toBe(200);
	});

	it.each([
		["registry", "/etc/passwd"],
		["tasks", "../../a2a-tasks.json"],
	])("rejects hosted %s path overrides", async (key, value) => {
		const req = makeReq(`/api/a2a/cockpit?${key}=${encodeURIComponent(value)}`);
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe(
			`${key} query parameter is not supported by the hosted A2A cockpit`,
		);
	});

	it("uses a short default probe timeout for the web panel", async () => {
		vi.mocked(buildA2ACockpit).mockResolvedValueOnce({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			counts: {
				peers: 0,
				onlinePeers: 0,
				unreachablePeers: 0,
				tasks: 0,
				runningTasks: 0,
				actionRequiredTasks: 0,
				failedTasks: 0,
				completedTasks: 0,
			},
			peers: [],
			tasks: [],
			nextActions: [],
		});
		const req = makeReq("/api/a2a/cockpit");
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).toHaveBeenCalledWith({
			registryPath: undefined,
			tasksPath: undefined,
			timeoutMs: 2500,
			peer: undefined,
			limit: undefined,
		});
	});

	it("rejects invalid numeric query values", async () => {
		const req = makeReq("/api/a2a/cockpit?limit=zero");
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("limit must be a positive integer");
	});

	it("rejects hosted probe timeouts above the bounded maximum", async () => {
		const req = makeReq("/api/a2a/cockpit?timeoutMs=1000000");
		const res = makeRes();

		await handleA2ACockpit(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(buildA2ACockpit).not.toHaveBeenCalled();
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("timeoutMs must be at most 10000");
	});
});

function makeReq(url: string, method = "GET"): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost" };
	req.end();
	return req;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		writeHead(status: number, headers?: Record<string, string | number>) {
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
