import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePackageStatus } from "../../src/server/handlers/package.js";

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
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

const tempDirs: string[] = [];

function createTempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-package-handler-"));
	tempDirs.push(dir);
	return dir;
}

function createMaestroPackage(root: string): string {
	const packageDir = join(root, "vendor", "pack");
	mkdirSync(join(packageDir, "skills", "pkg-skill"), { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "@test/package",
			keywords: ["maestro-package"],
			maestro: {
				skills: ["./skills"],
			},
		}),
		"utf-8",
	);
	return packageDir;
}

function createCommittedGitRepo(dir: string): void {
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
	commitGitRepoChanges(dir, "initial");
}

function commitGitRepoChanges(dir: string, message: string): void {
	execFileSync("git", ["add", "."], {
		cwd: dir,
		stdio: "ignore",
	});
	execFileSync("git", ["commit", "-m", message], {
		cwd: dir,
		stdio: "ignore",
	});
}

describe("handlePackageStatus", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("lists configured packages", async () => {
		const root = createTempProject();
		createMaestroPackage(root);
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const req = makeReq("/api/package");
		const res = makeRes();

		await handlePackageStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			packages: [
				{
					scope: "project",
					sourceSpec: "../vendor/pack",
					inspection: {
						discovered: {
							name: "@test/package",
							isMaestroPackage: true,
						},
					},
				},
			],
		});
	});

	it("adds a configured package using the local scope by default", async () => {
		const root = createTempProject();
		createMaestroPackage(root);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const req = makeReq("/api/package?action=add", {
			method: "POST",
			body: { source: "./vendor/pack" },
		});
		const res = makeRes();

		await handlePackageStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			path: join(root, ".maestro", "config.local.toml"),
			scope: "local",
			spec: "../vendor/pack",
		});
		expect(
			readFileSync(join(root, ".maestro", "config.local.toml"), "utf-8"),
		).toContain("../vendor/pack");
	});

	it("removes a configured package and returns the remaining fallback scope", async () => {
		const root = createTempProject();
		createMaestroPackage(root);
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);
		writeFileSync(
			join(root, ".maestro", "config.local.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const req = makeReq("/api/package?action=remove", {
			method: "POST",
			body: { source: "./vendor/pack" },
		});
		const res = makeRes();

		await handlePackageStatus(
			req as unknown as IncomingMessage,
			res as unknown as ServerResponse,
			corsHeaders,
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({
			path: join(root, ".maestro", "config.local.toml"),
			scope: "local",
			removedCount: 1,
			fallback: {
				scope: "project",
				sourceSpec: "../vendor/pack",
			},
		});
	});

	it("refreshes a configured git package source", async () => {
		const root = createTempProject();
		const packageDir = join(root, "vendor", "git-pack");
		mkdirSync(join(packageDir, "skills", "pkg-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "pkg-skill", "SKILL.md"),
			"# Package Skill\n",
			"utf-8",
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/git-package",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		createCommittedGitRepo(packageDir);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const inspectReq = makeReq("/api/package?action=inspect", {
			method: "POST",
			body: { source: `git:${packageDir}` },
		});
		const inspectRes = makeRes();
		await handlePackageStatus(
			inspectReq as unknown as IncomingMessage,
			inspectRes as unknown as ServerResponse,
			corsHeaders,
		);
		expect(inspectRes.statusCode).toBe(200);

		mkdirSync(join(packageDir, "skills", "deploy-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "deploy-skill", "SKILL.md"),
			"# Deploy Skill\n",
			"utf-8",
		);
		commitGitRepoChanges(packageDir, "add deploy skill");

		const refreshReq = makeReq("/api/package?action=refresh", {
			method: "POST",
			body: { source: `git:${packageDir}` },
		});
		const refreshRes = makeRes();

		await handlePackageStatus(
			refreshReq as unknown as IncomingMessage,
			refreshRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(refreshRes.statusCode).toBe(200);
		expect(JSON.parse(refreshRes.body)).toMatchObject({
			inspection: {
				discovered: {
					name: "@test/git-package",
				},
				resources: {
					skills: expect.arrayContaining([
						expect.stringContaining("deploy-skill"),
						expect.stringContaining("pkg-skill"),
					]),
				},
			},
			issues: [],
		});
	});

	it("refreshes all configured remote package sources", async () => {
		const root = createTempProject();
		createMaestroPackage(root);
		const packageDir = join(root, "vendor", "git-pack");
		mkdirSync(join(packageDir, "skills", "pkg-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "pkg-skill", "SKILL.md"),
			"# Package Skill\n",
			"utf-8",
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/git-package",
				version: "1.0.0",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		createCommittedGitRepo(packageDir);
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			`packages = ["../vendor/pack", "git:${packageDir}"]\n`,
			"utf-8",
		);
		vi.spyOn(process, "cwd").mockReturnValue(root);

		const inspectRes = makeRes();
		await handlePackageStatus(
			makeReq("/api/package?action=inspect", {
				method: "POST",
				body: { source: `git:${packageDir}` },
			}) as unknown as IncomingMessage,
			inspectRes as unknown as ServerResponse,
			corsHeaders,
		);
		expect(inspectRes.statusCode).toBe(200);

		mkdirSync(join(packageDir, "skills", "deploy-skill"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "deploy-skill", "SKILL.md"),
			"# Deploy Skill\n",
			"utf-8",
		);
		commitGitRepoChanges(packageDir, "add deploy skill");

		const refreshRes = makeRes();
		await handlePackageStatus(
			makeReq("/api/package?action=refresh-all", {
				method: "POST",
				body: {},
			}) as unknown as IncomingMessage,
			refreshRes as unknown as ServerResponse,
			corsHeaders,
		);

		expect(refreshRes.statusCode).toBe(200);
		expect(JSON.parse(refreshRes.body)).toMatchObject({
			localCount: 1,
			remoteCount: 1,
			refreshed: [
				{
					source: `git:${packageDir}`,
					sourceType: "git",
					scopes: ["project"],
					inspection: {
						discovered: {
							name: "@test/git-package",
						},
						resources: {
							skills: expect.arrayContaining([
								expect.stringContaining("deploy-skill"),
								expect.stringContaining("pkg-skill"),
							]),
						},
					},
					issues: [],
					error: null,
				},
			],
		});
	});
});
