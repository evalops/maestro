import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isDatabaseConfiguredMock, testConnectionMock } = vi.hoisted(() => ({
	isDatabaseConfiguredMock: vi.fn(() => true),
	testConnectionMock: vi.fn(async () => false),
}));

vi.mock("../../src/db/client.js", () => ({
	isDatabaseConfigured: isDatabaseConfiguredMock,
	testConnection: testConnectionMock,
}));

const { handleStatus, resetStatusDatabaseHealthCacheForTests } = await import(
	"../../src/server/handlers/status.js"
);

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

function makeReq(url: string): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = "GET";
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
			if (chunk) {
				this.write(chunk);
			}
			this.writableEnded = true;
		},
	};
}

describe("handleStatus database health", () => {
	beforeEach(() => {
		resetStatusDatabaseHealthCacheForTests();
		isDatabaseConfiguredMock.mockReset();
		testConnectionMock.mockReset();
		isDatabaseConfiguredMock.mockReturnValue(true);
		testConnectionMock.mockResolvedValue(false);
	});

	afterEach(() => {
		resetStatusDatabaseHealthCacheForTests();
		vi.useRealTimers();
	});

	it("reports database.connected from the readiness probe", async () => {
		const req = makeReq("/api/status");
		const res = makeRes();

		await handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(res.body).database).toEqual({
			configured: true,
			connected: false,
		});
	});

	it("bounds status responses while a database probe is still pending", async () => {
		let resolveProbe: ((connected: boolean) => void) | undefined;
		testConnectionMock.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				resolveProbe = resolve;
			}),
		);
		vi.useFakeTimers();

		const req = makeReq("/api/status");
		const res = makeRes();
		const response = handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		await vi.advanceTimersByTimeAsync(499);
		expect(res.writableEnded).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await response;

		expect(res.writableEnded).toBe(true);
		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(res.body).database).toEqual({
			configured: true,
			connected: false,
		});

		resolveProbe?.(true);
		await Promise.resolve();
	});

	it("reuses the eventual result from a probe that timed out the response", async () => {
		let resolveProbe: ((connected: boolean) => void) | undefined;
		testConnectionMock.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				resolveProbe = resolve;
			}),
		);
		vi.useFakeTimers();

		const firstReq = makeReq("/api/status");
		const firstRes = makeRes();
		const firstResponse = handleStatus(
			firstReq as unknown as IncomingMessage,
			firstRes as unknown as ServerResponse,
			corsHeaders,
		);

		await vi.advanceTimersByTimeAsync(500);
		await firstResponse;

		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(firstRes.body).database).toEqual({
			configured: true,
			connected: false,
		});

		resolveProbe?.(true);
		await Promise.resolve();
		await Promise.resolve();

		const secondReq = makeReq("/api/status");
		const secondRes = makeRes();
		await handleStatus(
			secondReq as unknown as IncomingMessage,
			secondRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(secondRes.body).database).toEqual({
			configured: true,
			connected: true,
		});
	});

	it("does not reuse stale successful health when a fresh probe times out", async () => {
		testConnectionMock
			.mockResolvedValueOnce(true)
			.mockReturnValueOnce(new Promise<boolean>(() => {}));
		vi.useFakeTimers();

		const firstReq = makeReq("/api/status");
		const firstRes = makeRes();
		await handleStatus(
			firstReq as unknown as IncomingMessage,
			firstRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(firstRes.body).database).toEqual({
			configured: true,
			connected: true,
		});

		await vi.advanceTimersByTimeAsync(5_001);

		const secondReq = makeReq("/api/status");
		const secondRes = makeRes();
		const secondResponse = handleStatus(
			secondReq as unknown as IncomingMessage,
			secondRes as unknown as ServerResponse,
			corsHeaders,
		);

		await vi.advanceTimersByTimeAsync(500);
		await secondResponse;

		expect(testConnectionMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(secondRes.body).database).toEqual({
			configured: true,
			connected: false,
		});
	});

	it("starts a fresh database probe after the retry window", async () => {
		let resolveFirstProbe: ((connected: boolean) => void) | undefined;
		testConnectionMock
			.mockReturnValueOnce(
				new Promise<boolean>((resolve) => {
					resolveFirstProbe = resolve;
				}),
			)
			.mockResolvedValueOnce(true);
		vi.useFakeTimers();

		const firstReq = makeReq("/api/status");
		const firstRes = makeRes();
		const firstResponse = handleStatus(
			firstReq as unknown as IncomingMessage,
			firstRes as unknown as ServerResponse,
			corsHeaders,
		);

		await vi.advanceTimersByTimeAsync(500);
		await firstResponse;

		expect(testConnectionMock).toHaveBeenCalledOnce();
		expect(JSON.parse(firstRes.body).database).toEqual({
			configured: true,
			connected: false,
		});

		await vi.advanceTimersByTimeAsync(5_001);

		const secondReq = makeReq("/api/status");
		const secondRes = makeRes();
		const secondResponse = handleStatus(
			secondReq as unknown as IncomingMessage,
			secondRes as unknown as ServerResponse,
			corsHeaders,
		);
		await vi.advanceTimersByTimeAsync(500);
		await secondResponse;

		expect(testConnectionMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(secondRes.body).database).toEqual({
			configured: true,
			connected: false,
		});

		await vi.advanceTimersByTimeAsync(29_001);

		const thirdReq = makeReq("/api/status");
		const thirdRes = makeRes();
		await handleStatus(
			thirdReq as unknown as IncomingMessage,
			thirdRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(testConnectionMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(thirdRes.body).database).toEqual({
			configured: true,
			connected: true,
		});

		resolveFirstProbe?.(false);
		await Promise.resolve();
		await Promise.resolve();

		const fourthReq = makeReq("/api/status");
		const fourthRes = makeRes();
		await handleStatus(
			fourthReq as unknown as IncomingMessage,
			fourthRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(testConnectionMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(fourthRes.body).database).toEqual({
			configured: true,
			connected: true,
		});
	});
});
