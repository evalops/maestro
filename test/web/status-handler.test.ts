import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDatabaseConfigured, testConnection } from "../../src/db/client.js";
import {
	buildRunHealthSnapshot,
	handleStatus,
	resetStatusDatabaseHealthCacheForTests,
} from "../../src/server/handlers/status.js";

vi.mock("../../src/db/client.js", () => ({
	isDatabaseConfigured: vi.fn(() => false),
	testConnection: vi.fn(async () => false),
}));

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

let statusProjectRoot: string | undefined;

async function readStatus(
	options: { method?: string; body?: unknown; cwd?: string } = {},
) {
	const req = makeReq("/api/status", options);
	const res = makeRes();

	await handleStatus(
		req as unknown as IncomingMessage,
		res as unknown as ServerResponse,
		corsHeaders,
		{ cwd: options.cwd ?? statusProjectRoot },
	);

	expect(res.statusCode).toBe(200);
	return JSON.parse(res.body) as Record<string, unknown>;
}

describe("buildRunHealthSnapshot", () => {
	it("summarizes healthy local mode with all SLO lanes", () => {
		const health = buildRunHealthSnapshot({
			apiLatencyMs: 42,
			backgroundTasks: {
				running: 1,
				failed: 0,
				restarting: 0,
			},
			database: {
				configured: false,
				connected: false,
			},
			hooks: {
				asyncInFlight: 0,
				concurrency: {
					max: 4,
					active: 1,
					queued: 0,
				},
			},
			generatedAt: Date.parse("2026-05-22T12:00:00.000Z"),
		});

		expect(health).toMatchObject({
			status: "healthy",
			diagnostics: [],
			generatedAt: "2026-05-22T12:00:00.000Z",
		});
		expect(health.slos.map((slo) => slo.id)).toEqual([
			"api_latency",
			"database",
			"background_tasks",
			"hook_queue",
		]);
	});

	it("escalates unhealthy SLO lanes into operator diagnostics", () => {
		const health = buildRunHealthSnapshot({
			apiLatencyMs: 3200,
			backgroundTasks: {
				running: 0,
				failed: 1,
				restarting: 0,
			},
			database: {
				configured: true,
				connected: false,
			},
			hooks: {
				asyncInFlight: 2,
				concurrency: {
					max: 1,
					active: 1,
					queued: 3,
				},
			},
			generatedAt: Date.parse("2026-05-22T12:05:00.000Z"),
		});

		expect(health.status).toBe("unhealthy");
		expect(health.diagnostics).toEqual([
			"API latency: 3200ms",
			"Database: disconnected",
			"Background tasks: 0 running, 1 failed, 0 restarting",
			"Hook queue: 1/1 active, 3 queued, 2 async",
		]);
	});
});

describe("handleStatus", () => {
	let tempRoot: string;
	let originalMaestroHome: string | undefined;
	let originalDatabaseUrl: string | undefined;
	let originalMaestroDatabaseUrl: string | undefined;

	beforeEach(() => {
		vi.mocked(isDatabaseConfigured).mockReturnValue(false);
		vi.mocked(testConnection).mockResolvedValue(false);
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-status-handler-"));
		statusProjectRoot = tempRoot;
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalDatabaseUrl = process.env.DATABASE_URL;
		originalMaestroDatabaseUrl = process.env.MAESTRO_DATABASE_URL;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
		Reflect.deleteProperty(process.env, "DATABASE_URL");
		Reflect.deleteProperty(process.env, "MAESTRO_DATABASE_URL");
		resetStatusDatabaseHealthCacheForTests();
		vi.mocked(isDatabaseConfigured).mockReset();
		vi.mocked(testConnection).mockReset();
		vi.mocked(isDatabaseConfigured).mockReturnValue(false);
		vi.mocked(testConnection).mockResolvedValue(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetStatusDatabaseHealthCacheForTests();
		statusProjectRoot = undefined;
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		if (originalDatabaseUrl === undefined) {
			Reflect.deleteProperty(process.env, "DATABASE_URL");
		} else {
			process.env.DATABASE_URL = originalDatabaseUrl;
		}
		if (originalMaestroDatabaseUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_DATABASE_URL");
		} else {
			process.env.MAESTRO_DATABASE_URL = originalMaestroDatabaseUrl;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("includes project onboarding data in status snapshots", async () => {
		writeFileSync(join(tempRoot, "package.json"), "{}");

		await expect(readStatus()).resolves.toMatchObject({
			cwd: tempRoot,
			runHealth: {
				status: "healthy",
				slos: [
					{ id: "api_latency" },
					{ id: "database" },
					{ id: "background_tasks" },
					{ id: "hook_queue" },
				],
			},
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

	it("checks configured database reachability in status snapshots", async () => {
		vi.mocked(isDatabaseConfigured).mockReturnValue(true);
		vi.mocked(testConnection).mockResolvedValue(false);

		const status = await readStatus();

		expect(testConnection).toHaveBeenCalledTimes(1);
		expect(status).toMatchObject({
			database: {
				configured: true,
				connected: false,
			},
		});
	});

	it("records onboarding impressions through the status action endpoint", async () => {
		writeFileSync(join(tempRoot, "package.json"), "{}");
		mkdirSync(join(tempRoot, ".maestro"), { recursive: true });

		const markReq = makeReq("/api/status?action=mark-onboarding-seen", {
			method: "POST",
		});
		const markRes = makeRes();

		await handleStatus(
			markReq as unknown as IncomingMessage,
			markRes as unknown as ServerResponse,
			corsHeaders,
			{ cwd: tempRoot },
		);

		expect(markRes.statusCode).toBe(200);
		expect(JSON.parse(markRes.body)).toEqual({ success: true });

		await expect(readStatus()).resolves.toMatchObject({
			onboarding: {
				seenCount: 1,
				shouldShow: true,
			},
		});
	});

	it("reports database connectivity from a live probe", async () => {
		vi.mocked(isDatabaseConfigured).mockReturnValue(true);
		vi.mocked(testConnection).mockResolvedValueOnce(true);

		await expect(readStatus()).resolves.toMatchObject({
			database: {
				configured: true,
				connected: true,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(1);
	});

	it("uses late timed-out probe results to refresh database health", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		vi.mocked(isDatabaseConfigured).mockReturnValue(true);
		vi.mocked(testConnection).mockResolvedValueOnce(true);

		await expect(readStatus()).resolves.toMatchObject({
			database: {
				configured: true,
				connected: true,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(5_001);

		let resolveSlowProbe: ((connected: boolean) => void) | undefined;
		vi.mocked(testConnection).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSlowProbe = resolve;
				}),
		);

		const timedOutStatus = readStatus();
		await vi.advanceTimersByTimeAsync(500);
		await expect(timedOutStatus).resolves.toMatchObject({
			database: {
				configured: true,
				connected: false,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(2);

		resolveSlowProbe?.(false);
		await vi.runAllTicks();
		await Promise.resolve();

		await expect(readStatus()).resolves.toMatchObject({
			database: {
				configured: true,
				connected: false,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(2);
	});

	it("retries stuck database health probes only after the retry cap", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		vi.mocked(isDatabaseConfigured).mockReturnValue(true);

		let resolveFirstProbe: ((connected: boolean) => void) | undefined;
		vi.mocked(testConnection).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					resolveFirstProbe = resolve;
				}),
		);

		const firstStatus = readStatus();
		await vi.advanceTimersByTimeAsync(500);
		await expect(firstStatus).resolves.toMatchObject({
			database: {
				configured: true,
				connected: false,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(1);

		const secondStatus = readStatus();
		await vi.advanceTimersByTimeAsync(500);
		await expect(secondStatus).resolves.toMatchObject({
			database: {
				configured: true,
				connected: false,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		vi.mocked(testConnection).mockResolvedValueOnce(true);

		await expect(readStatus()).resolves.toMatchObject({
			database: {
				configured: true,
				connected: true,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(2);

		resolveFirstProbe?.(false);
		await vi.runAllTicks();
		await Promise.resolve();

		await expect(readStatus()).resolves.toMatchObject({
			database: {
				configured: true,
				connected: true,
			},
		});
		expect(testConnection).toHaveBeenCalledTimes(2);
	});
});
