import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMemory } from "../../src/server/handlers/memory.js";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
const originalMaestroHome = process.env.MAESTRO_HOME;

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
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

const tempDirs: string[] = [];

function createTempProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function initRepo(dir: string): void {
	execFileSync("git", ["init", "--initial-branch=main"], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.email", "maestro@example.com"], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Maestro Tests"], {
		cwd: dir,
		stdio: "ignore",
	});
}

describe("handleMemory team actions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (originalMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("reports team memory availability outside git repositories", async () => {
		const root = createTempProject("maestro-memory-handler-");
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const req = makeReq("/api/memory?action=team");
		const res = makeRes();

		await handleMemory(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			available: false,
			status: null,
		});
	});

	it("initializes repo-scoped team memory from the handler", async () => {
		const root = createTempProject("maestro-team-memory-handler-");
		const maestroHome = createTempProject("maestro-team-memory-home-");
		process.env.MAESTRO_HOME = maestroHome;
		initRepo(root);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const req = makeReq("/api/memory", {
			method: "POST",
			body: { action: "team-init" },
		});
		const res = makeRes();

		await handleMemory(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		const payload = JSON.parse(res.body);
		expect(payload.success).toBe(true);
		expect(payload.status.entrypoint).toContain("MEMORY.md");
		expect(readFileSync(payload.status.entrypoint, "utf-8")).toContain(
			"# Team Memory",
		);
	});
});
