import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../../src/db/client.js";
import {
	buildRunHealthSnapshot,
	handleStatus,
} from "../../src/server/handlers/status.js";

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
	let originalCwd: string;
	let originalMaestroHome: string | undefined;
	let originalDatabaseUrl: string | undefined;
	let originalMaestroDatabaseUrl: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-status-handler-"));
		originalCwd = process.cwd();
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalDatabaseUrl = process.env.DATABASE_URL;
		originalMaestroDatabaseUrl = process.env.MAESTRO_DATABASE_URL;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
		Reflect.deleteProperty(process.env, "DATABASE_URL");
		Reflect.deleteProperty(process.env, "MAESTRO_DATABASE_URL");
		process.chdir(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
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

		const req = makeReq("/api/status");
		const res = makeRes();

		await handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			cwd: process.cwd(),
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

	it("does not mark a lazy configured database unhealthy before first query", async () => {
		process.env.MAESTRO_DATABASE_URL = "postgresql://127.0.0.1:1/maestro";
		writeFileSync(join(tempRoot, "package.json"), "{}");

		const req = makeReq("/api/status");
		const res = makeRes();

		await handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		const payload = JSON.parse(res.body);
		expect(payload.database).toMatchObject({
			configured: true,
			connected: false,
			initialized: false,
		});
		expect(payload.runHealth.status).toBe("healthy");
		expect(
			payload.runHealth.slos.find(
				(slo: { id: string }) => slo.id === "database",
			),
		).toMatchObject({
			status: "healthy",
			observed: "configured, idle",
		});
	});

	it("verifies initialized database reachability before reporting healthy", async () => {
		vi.spyOn(dbClient, "isDatabaseConfigured").mockReturnValue(true);
		vi.spyOn(dbClient, "isDbAvailable").mockReturnValue(true);
		vi.spyOn(dbClient, "testConnection").mockResolvedValue(false);
		writeFileSync(join(tempRoot, "package.json"), "{}");

		const req = makeReq("/api/status");
		const res = makeRes();

		await handleStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		const payload = JSON.parse(res.body);
		expect(dbClient.testConnection).toHaveBeenCalled();
		expect(payload.database).toMatchObject({
			configured: true,
			connected: false,
			initialized: true,
			reachable: false,
		});
		expect(payload.runHealth.status).toBe("unhealthy");
		expect(
			payload.runHealth.slos.find(
				(slo: { id: string }) => slo.id === "database",
			),
		).toMatchObject({
			status: "unhealthy",
			observed: "unreachable",
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
		);

		expect(markRes.statusCode).toBe(200);
		expect(JSON.parse(markRes.body)).toEqual({ success: true });

		const statusReq = makeReq("/api/status");
		const statusRes = makeRes();
		await handleStatus(
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
