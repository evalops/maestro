import { Buffer } from "node:buffer";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { parse as parseTOML } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	type MaestroAppServerExternalAgentImport,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { loadMcpConfig } from "../../src/mcp/config.js";
import { SessionManager } from "../../src/session/manager.js";
import { loadSkills } from "../../src/skills/loader.js";

function jsonLines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

describe("Maestro app-server external agent import API", () => {
	let testDir: string;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-import-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, "home");
	});

	afterEach(() => {
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("advertises the external agent import capability", () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				externalAgentImport: true,
			},
		});
	});

	it("does not expose external agent imports when session persistence is disabled", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "disabled-sessions"),
		});
		manager.disable();
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "disabled-project");

		expect(api.initialize()).toMatchObject({
			capabilities: {
				externalAgentImport: false,
			},
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-disabled",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "config",
						scope: "local",
						values: { model: "gpt-5.1" },
					},
				],
			},
		});

		expect(response.error).toEqual({
			code: -32601,
			message: "External agent import is not available",
		});
		expect(existsSync(join(projectRoot, ".maestro", "config.local.toml"))).toBe(
			false,
		);
	});

	it("imports sessions, config, hooks, MCP servers, and skills from one bundle", async () => {
		const projectRoot = join(testDir, "project");
		const sourceManager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "source-sessions"),
		});
		const targetManager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "target-sessions"),
		});
		await sourceManager.createSession({ title: "External thread" });
		const sourceEntries = jsonLines(sourceManager.getSessionFile());
		const api = createMaestroAppServerSessionApi(targetManager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				source: { name: "codex", type: "openai-codex" },
				artifacts: [
					{ kind: "session", entries: sourceEntries },
					{
						kind: "config",
						scope: "local",
						values: {
							model: "gpt-5.1",
							features: { web_search_request: true },
						},
					},
					{
						kind: "hooks",
						scope: "project",
						hooks: {
							SessionStart: [
								{
									matcher: "*",
									hooks: [
										{
											type: "command",
											command: "./scripts/session-start.sh",
										},
									],
								},
							],
						},
					},
					{
						kind: "mcp",
						scope: "local",
						server: {
							name: "codex_context",
							command: "node",
							args: ["server.js"],
						},
					},
					{
						kind: "skill",
						scope: "project",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported review workflow from another agent.\n---\n\n# Codex Review\n",
							},
							{ path: "reference/notes.md", content: "Imported notes\n" },
							{
								path: "assets/raw.bin",
								contentBase64: Buffer.from([0, 255, 128, 65]).toString(
									"base64",
								),
							},
						],
					},
				],
			},
		});

		expect(response.error).toBeUndefined();
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
		expect(response.result).toMatchObject({
			source: { name: "codex", type: "openai-codex" },
			dryRun: false,
			warnings: [],
		});
		expect(response.result?.imported.map((artifact) => artifact.kind)).toEqual([
			"session",
			"config",
			"hooks",
			"mcp",
			"skill",
		]);
		expect(targetManager.loadAllSessions()).toHaveLength(1);

		const configPath = join(projectRoot, ".maestro", "config.local.toml");
		const config = parseTOML(readFileSync(configPath, "utf8")) as {
			model?: string;
			features?: { web_search_request?: boolean };
		};
		expect(config.model).toBe("gpt-5.1");
		expect(config.features?.web_search_request).toBe(true);

		const hooksPath = join(projectRoot, ".maestro", "hooks.json");
		const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
			hooks?: { SessionStart?: Array<{ matcher?: string }> };
		};
		expect(hooks.hooks?.SessionStart?.[0]?.matcher).toBe("*");

		expect(loadMcpConfig(projectRoot).servers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "codex_context",
					command: "node",
					args: ["server.js"],
				}),
			]),
		);
		expect(loadSkills(projectRoot, { includeSystem: false }).skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "codex-review",
					sourceType: "project",
				}),
			]),
		);
		expect(
			readFileSync(
				join(
					projectRoot,
					".maestro",
					"skills",
					"codex-review",
					"assets",
					"raw.bin",
				),
			),
		).toEqual(Buffer.from([0, 255, 128, 65]));
	});

	it("previews imports without writing files", async () => {
		const projectRoot = join(testDir, "dry-run-project");
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run",
			method: "externalAgent/import",
			params: {
				projectRoot,
				artifacts: [
					{
						kind: "config",
						scope: "local",
						content: 'model = "gpt-5.1"\n',
					},
				],
			},
		});

		expect(response.result).toMatchObject({
			dryRun: true,
			imported: [{ kind: "config", status: "planned" }],
		});
		expect(existsSync(join(projectRoot, ".maestro", "config.local.toml"))).toBe(
			false,
		);
	});

	it("validates existing config targets during dry-run imports", async () => {
		const projectRoot = join(testDir, "dry-run-config-project");
		const configPath = join(projectRoot, ".maestro", "config.local.toml");
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-config-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		mkdirSync(join(projectRoot, ".maestro"), { recursive: true });
		writeFileSync(configPath, "model =\n", "utf8");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run-invalid-config-target",
			method: "externalAgent/import",
			params: {
				dryRun: true,
				projectRoot,
				artifacts: [
					{
						kind: "config",
						scope: "local",
						values: { model: "gpt-5.1" },
					},
				],
			},
		});

		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "config", status: "skipped" }),
		]);
		expect(response.result?.warnings).toHaveLength(1);
		expect(readFileSync(configPath, "utf8")).toBe("model =\n");
	});

	it("validates existing hooks targets during dry-run imports", async () => {
		const projectRoot = join(testDir, "dry-run-hooks-project");
		const hooksPath = join(projectRoot, ".maestro", "hooks.json");
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-hooks-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		mkdirSync(join(projectRoot, ".maestro"), { recursive: true });
		writeFileSync(hooksPath, "{not-json", "utf8");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run-invalid-hooks-target",
			method: "externalAgent/import",
			params: {
				dryRun: true,
				projectRoot,
				artifacts: [
					{
						kind: "hooks",
						scope: "project",
						hooks: { SessionStart: [] },
					},
				],
			},
		});

		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "hooks", status: "skipped" }),
		]);
		expect(response.result?.warnings).toHaveLength(1);
		expect(readFileSync(hooksPath, "utf8")).toBe("{not-json");
	});

	it("rejects local hooks scope instead of writing project hooks", async () => {
		const projectRoot = join(testDir, "local-hooks-project");
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "local-hooks-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-local-hooks",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "hooks",
						scope: "local",
						hooks: { SessionStart: [] },
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"Hooks artifact does not support local scope",
		]);
		expect(response.result?.imported).toEqual([
			expect.objectContaining({
				kind: "hooks",
				status: "skipped",
				message: "Hooks artifact does not support local scope",
			}),
		]);
		expect(existsSync(join(projectRoot, ".maestro", "hooks.json"))).toBe(false);
	});

	it("blocks skill file path traversal", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "unsafe-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-unsafe",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot: join(testDir, "unsafe-project"),
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported.\n---\n",
							},
							{ path: "../escape.txt", content: "nope" },
						],
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"Imported file path must stay inside its target directory",
		]);
		expect(
			existsSync(
				join(
					testDir,
					"unsafe-project",
					".maestro",
					"skills",
					"codex-review",
					"SKILL.md",
				),
			),
		).toBe(false);
		expect(existsSync(join(testDir, "unsafe-project", "escape.txt"))).toBe(
			false,
		);
	});

	it("blocks Windows-style skill file path traversal", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "unsafe-windows-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "unsafe-windows-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-unsafe-windows",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported.\n---\n",
							},
							{ path: "..\\escape.txt", content: "nope" },
						],
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"Imported file path must stay inside its target directory",
		]);
		expect(
			existsSync(join(projectRoot, ".maestro", "skills", "codex-review")),
		).toBe(false);
		expect(existsSync(join(projectRoot, "escape.txt"))).toBe(false);
	});

	it("rejects malformed skill file entries without writing files", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "malformed-skill-files-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "malformed-skill-files-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-malformed-skill-files",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported.\n---\n",
							},
							"not-a-file-record",
						],
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"Skill artifact files must be objects",
		]);
		expect(
			existsSync(join(projectRoot, ".maestro", "skills", "codex-review")),
		).toBe(false);
	});

	it("does not leave partial skill files when a staged write fails", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "atomic-skill-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "atomic-skill-project");
		const targetDir = join(projectRoot, ".maestro", "skills", "codex-review");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-atomic-skill",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported.\n---\n",
							},
							{ path: "dir", content: "file first\n" },
							{ path: "dir/nested.txt", content: "nested later\n" },
						],
					},
				],
			},
		});

		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "skill", status: "skipped" }),
		]);
		expect(response.result?.warnings).toHaveLength(1);
		expect(existsSync(targetDir)).toBe(false);
	});

	it("preserves existing skill files when a staged replacement fails", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "existing-atomic-skill-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "existing-atomic-skill-project");
		const targetDir = join(projectRoot, ".maestro", "skills", "codex-review");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(
			join(targetDir, "SKILL.md"),
			"---\nname: codex-review\ndescription: Existing skill.\n---\n",
			"utf8",
		);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-existing-atomic-skill",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								content:
									"---\nname: codex-review\ndescription: Imported.\n---\n",
							},
							{ path: "dir", content: "file first\n" },
							{ path: "dir/nested.txt", content: "nested later\n" },
						],
					},
				],
			},
		});

		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "skill", status: "skipped" }),
		]);
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf8")).toContain(
			"Existing skill",
		);
		expect(existsSync(join(targetDir, "dir"))).toBe(false);
	});

	it("validates MCP servers during dry-run imports", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-mcp-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run-invalid-mcp",
			method: "externalAgent/import",
			params: {
				dryRun: true,
				projectRoot: join(testDir, "dry-run-mcp-project"),
				artifacts: [
					{
						kind: "mcp",
						server: {
							name: "broken_stdio",
						},
					},
				],
			},
		});

		expect(response.result?.warnings[0]).toContain(
			"Stdio transport requires command",
		);
		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "mcp", status: "skipped" }),
		]);
	});

	it("validates all MCP servers before writing any server", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "atomic-mcp-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "atomic-mcp-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-atomic-mcp",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "mcp",
						scope: "local",
						servers: [
							{
								name: "valid_stdio",
								command: "node",
							},
							{
								name: "broken_stdio",
							},
						],
					},
				],
			},
		});

		expect(response.result?.warnings[0]).toContain(
			"Stdio transport requires command",
		);
		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "mcp", status: "skipped" }),
		]);
		expect(existsSync(join(projectRoot, ".maestro", "mcp.local.json"))).toBe(
			false,
		);
	});

	it("rejects malformed MCP server entries before writing any server", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "malformed-mcp-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "malformed-mcp-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-malformed-mcp",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "mcp",
						scope: "local",
						servers: [
							{
								name: "valid_stdio",
								command: "node",
							},
							"not-a-server-record",
						],
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"MCP artifact servers must be objects",
		]);
		expect(existsSync(join(projectRoot, ".maestro", "mcp.local.json"))).toBe(
			false,
		);
	});

	it("rejects duplicate MCP servers before partially writing a bundle", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "duplicate-mcp-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "duplicate-mcp-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-duplicate-mcp",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "mcp",
						scope: "local",
						servers: [
							{
								name: "duplicate_stdio",
								command: "node",
							},
							{
								name: "duplicate_stdio",
								command: "python",
							},
						],
					},
				],
			},
		});

		expect(response.result?.warnings[0]).toContain(
			'MCP server "duplicate_stdio" is listed more than once',
		);
		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "mcp", status: "skipped" }),
		]);
		expect(existsSync(join(projectRoot, ".maestro", "mcp.local.json"))).toBe(
			false,
		);
	});

	it("validates dry-run MCP imports against the target config", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-target-mcp-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "dry-run-target-mcp-project");
		const configPath = join(projectRoot, ".maestro", "mcp.local.json");
		mkdirSync(join(projectRoot, ".maestro"), { recursive: true });
		writeFileSync(
			configPath,
			`${JSON.stringify({
				servers: [
					{
						name: "existing_stdio",
						transport: "stdio",
						command: "node",
					},
				],
			})}\n`,
		);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run-target-mcp",
			method: "externalAgent/import",
			params: {
				dryRun: true,
				projectRoot,
				artifacts: [
					{
						kind: "mcp",
						scope: "local",
						server: {
							name: "existing_stdio",
							command: "node",
						},
					},
				],
			},
		});

		expect(response.result?.warnings[0]).toContain(
			'MCP server "existing_stdio" already exists',
		);
		expect(response.result?.imported).toEqual([
			expect.objectContaining({ kind: "mcp", status: "skipped" }),
		]);
		expect(readFileSync(configPath, "utf8")).toContain("existing_stdio");
	});

	it("validates session artifacts during dry-run imports", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "dry-run-session-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const missingPath = join(testDir, "missing-session.jsonl");
		const directoryPath = join(testDir, "session-directory");
		const malformedJsonPath = join(testDir, "malformed-session.json");
		const missingHeaderPath = join(testDir, "missing-header-session.jsonl");
		mkdirSync(directoryPath, { recursive: true });
		writeFileSync(malformedJsonPath, "{not-json", "utf8");
		writeFileSync(
			missingHeaderPath,
			`${JSON.stringify({
				type: "custom",
				id: "custom-1",
				timestamp: "2026-05-24T18:00:00.000Z",
			})}\n`,
			"utf8",
		);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-dry-run-invalid-session",
			method: "externalAgent/import",
			params: {
				dryRun: true,
				projectRoot: join(testDir, "dry-run-session-project"),
				artifacts: [
					{
						kind: "session",
						entries: [{ missing: "type" }],
					},
					{
						kind: "session",
						path: missingPath,
					},
					{
						kind: "session",
						path: directoryPath,
					},
					{
						kind: "session",
						path: malformedJsonPath,
					},
					{
						kind: "session",
						path: missingHeaderPath,
					},
				],
			},
		});

		expect(response.result?.imported).toEqual([
			expect.objectContaining({
				kind: "session",
				status: "skipped",
				message: "Session artifact entries must contain valid session entries",
			}),
			expect.objectContaining({
				kind: "session",
				status: "skipped",
				message: `Session file not found: ${missingPath}`,
			}),
			expect.objectContaining({
				kind: "session",
				status: "skipped",
				message: `Session path is not a file: ${directoryPath}`,
			}),
			expect.objectContaining({
				kind: "session",
				status: "skipped",
				message: expect.stringContaining(
					"Portable session export is not valid JSON",
				),
			}),
			expect.objectContaining({
				kind: "session",
				status: "skipped",
				message: "Imported session file is missing a session header.",
			}),
		]);
		expect(response.result?.warnings).toEqual([
			"Session artifact entries must contain valid session entries",
			`Session file not found: ${missingPath}`,
			`Session path is not a file: ${directoryPath}`,
			expect.stringContaining("Portable session export is not valid JSON"),
			"Imported session file is missing a session header.",
		]);
		expect(manager.loadAllSessions()).toHaveLength(0);
	});

	it("rejects invalid skill file base64 without writing files", async () => {
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "invalid-base64-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager);
		const projectRoot = join(testDir, "invalid-base64-project");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-invalid-base64",
			method: "externalAgent/import",
			params: {
				dryRun: false,
				projectRoot,
				artifacts: [
					{
						kind: "skill",
						name: "codex-review",
						files: [
							{
								path: "SKILL.md",
								contentBase64: "not base64!",
							},
						],
					},
				],
			},
		});

		expect(response.result?.warnings).toEqual([
			"Skill file contentBase64 is not valid base64",
		]);
		expect(
			existsSync(join(projectRoot, ".maestro", "skills", "codex-review")),
		).toBe(false);
	});

	it("rejects malformed import params before invoking injected adapters", async () => {
		let invoked = false;
		const externalAgentImport: MaestroAppServerExternalAgentImport = {
			importBundle: async () => {
				invoked = true;
				throw new Error("adapter should not be called");
			},
		};
		const manager = new SessionManager(false, undefined, {
			sessionDir: join(testDir, "invalid-params-sessions"),
		});
		const api = createMaestroAppServerSessionApi(manager, {
			externalAgentImport,
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "external-agent-import-invalid-params",
			method: "externalAgent/import",
			params: ["not", "an", "object"] as unknown as Record<string, unknown>,
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});
		expect(invoked).toBe(false);
	});
});
