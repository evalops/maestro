import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleContextCommand,
	renderContextManifestDiff,
	renderContextManifestSummary,
} from "../../src/cli/commands/context.js";
import {
	diffUnifiedContextManifests,
	loadUnifiedContextManifest,
} from "../../src/context/manifest.js";

describe("context command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "maestro-context-command-"));
		tempDirs.push(dir);
		return dir;
	}

	it("renders a prompt context manifest summary", () => {
		const root = makeTempDir();
		const app = join(root, "apps", "web");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "root rules");
		writeFileSync(join(app, "AGENTS.md"), "app rules");

		const summary = renderContextManifestSummary(
			loadUnifiedContextManifest(app, {
				mcpConfig: { servers: [], authPresets: [] },
			}),
		);

		expect(summary).toContain(`Prompt context for ${resolve(app)}`);
		expect(summary).toContain("Loaded files:");
		expect(summary).toContain("AGENTS.md");
		expect(summary).toContain("sha256:");
		expect(summary).toContain("multiple_instruction_layers");
	});

	it("prints json for context explain --json", async () => {
		const root = makeTempDir();
		writeFileSync(join(root, "AGENTS.md"), "root rules");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleContextCommand("explain", [root, "--json"]);

		const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(payload.cwd).toBe(resolve(root));
		expect(payload.version).toBe(1);
		expect(payload.projectDocs.entries[0]).toMatchObject({
			path: resolve(join(root, "AGENTS.md")),
			sourceKind: "project",
			candidateName: "AGENTS.md",
			precedenceIndex: 0,
		});
		expect(payload.entries[0]).toMatchObject({
			kind: "project_doc",
			path: resolve(join(root, "AGENTS.md")),
		});
	});

	it("includes configured MCP servers in the unified manifest", () => {
		const root = makeTempDir();
		const manifest = loadUnifiedContextManifest(root, {
			mcpConfig: {
				authPresets: [],
				servers: [
					{
						name: "docs",
						transport: "http",
						url: "https://mcp.example.test",
						scope: "project",
					},
				],
			},
		});

		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_server:docs",
				kind: "mcp_server",
				source: "mcp_config",
				status: "configured",
				serverName: "docs",
				metadata: expect.objectContaining({
					transport: "http",
					url: {
						host: "mcp.example.test",
						redacted: true,
						scheme: "https",
					},
				}),
			}),
		);
	});

	it("redacts expanded MCP config strings from manifest metadata", () => {
		const root = makeTempDir();
		const manifest = loadUnifiedContextManifest(root, {
			mcpConfig: {
				authPresets: [],
				servers: [
					{
						name: "secrets",
						transport: "stdio",
						command: "mcp-super-secret-token",
						args: ["--token", "super-secret-token"],
						cwd: "/tmp/super-secret-token",
						headersHelper: "echo super-secret-token",
					},
					{
						name: "remote",
						transport: "http",
						url: "https://example.test/super-secret-token?token=super-secret-token",
					},
				],
			},
		});

		const serialized = JSON.stringify(manifest);
		expect(serialized).not.toContain("super-secret-token");
		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_server:secrets",
				metadata: expect.objectContaining({
					command: { configured: true, redacted: true },
					args: { count: 2, redacted: true },
					cwdConfigured: true,
					headersHelperConfigured: true,
				}),
			}),
		);
		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_server:remote",
				metadata: expect.objectContaining({
					url: { host: "example.test", redacted: true, scheme: "https" },
				}),
			}),
		);
	});

	it("includes runtime MCP resources and prompts when status is supplied", () => {
		const root = makeTempDir();
		const manifest = loadUnifiedContextManifest(root, {
			mcpStatus: {
				authPresets: [],
				servers: [
					{
						name: "docs",
						connected: false,
						transport: "http",
						command: "runtime-super-secret-token",
						error: "failed with runtime-super-secret-token",
						tools: [],
						resources: ["docs://guide"],
						prompts: ["summarize"],
						promptDetails: [
							{
								name: "summarize",
								description: "Summarize a document",
								arguments: [{ name: "uri", required: true }],
							},
						],
					},
				],
			},
		});

		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_resource:docs:docs://guide",
				kind: "mcp_resource",
				uri: "docs://guide",
			}),
		);
		expect(JSON.stringify(manifest)).not.toContain(
			"runtime-super-secret-token",
		);
		expect(JSON.stringify(manifest)).not.toContain(
			"failed with runtime-super-secret-token",
		);
		expect(JSON.stringify(manifest.diagnostics)).toContain(
			"error details redacted",
		);
		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_server:docs",
				metadata: expect.objectContaining({
					command: { configured: true, redacted: true },
					error: { present: true, redacted: true },
				}),
			}),
		);
		expect(manifest.entries).toContainEqual(
			expect.objectContaining({
				id: "mcp_prompt:docs:summarize",
				kind: "mcp_prompt",
				promptName: "summarize",
				metadata: expect.objectContaining({
					description: "Summarize a document",
				}),
			}),
		);
	});

	it("renders context diffs", () => {
		const beforeRoot = makeTempDir();
		const afterRoot = makeTempDir();
		writeFileSync(join(beforeRoot, "AGENTS.md"), "root rules");
		writeFileSync(join(afterRoot, "AGENTS.md"), "new root rules");
		writeFileSync(join(afterRoot, "CLAUDE.md"), "fallback rules");

		const diff = diffUnifiedContextManifests(
			loadUnifiedContextManifest(beforeRoot, {
				mcpConfig: { servers: [], authPresets: [] },
			}),
			loadUnifiedContextManifest(afterRoot, {
				mcpConfig: { servers: [], authPresets: [] },
			}),
		);
		const rendered = renderContextManifestDiff(diff);

		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(1);
		expect(rendered).toContain("Context diff");
		expect(rendered).toContain("Summary:");
	});

	it("matches project docs across workspace roots by logical path", () => {
		const beforeRoot = makeTempDir();
		const afterRoot = makeTempDir();
		writeFileSync(join(beforeRoot, "AGENTS.md"), "root rules");
		writeFileSync(join(afterRoot, "AGENTS.md"), "root rules");

		const diff = diffUnifiedContextManifests(
			loadUnifiedContextManifest(beforeRoot, {
				mcpConfig: { servers: [], authPresets: [] },
			}),
			loadUnifiedContextManifest(afterRoot, {
				mcpConfig: { servers: [], authPresets: [] },
			}),
		);

		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(0);
		expect(diff.unchanged).toContainEqual(
			expect.objectContaining({
				id: "project_doc:project:AGENTS.md",
				kind: "project_doc",
				label: "AGENTS.md",
			}),
		);
	});

	it("prints json for context diff --json", async () => {
		const beforeRoot = makeTempDir();
		const afterRoot = makeTempDir();
		writeFileSync(join(beforeRoot, "AGENTS.md"), "root rules");
		writeFileSync(join(afterRoot, "AGENTS.md"), "new root rules");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleContextCommand("diff", [beforeRoot, afterRoot, "--json"]);

		const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(payload.beforeCwd).toBe(resolve(beforeRoot));
		expect(payload.afterCwd).toBe(resolve(afterRoot));
		expect(payload.changed).toHaveLength(1);
	});
});
