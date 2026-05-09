import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../../src/config/index.js";
import {
	UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
	type UnifiedContextManifest,
	diffUnifiedContextManifests,
	loadUnifiedContextManifest,
	validateUnifiedContextManifestContract,
} from "../../src/context/manifest.js";

const tempDirs: string[] = [];

function createWorkspace(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	writeFileSync(join(dir, "AGENTS.md"), "Keep context durable.\n");
	return dir;
}

function issueMessages(manifest: UnifiedContextManifest): string[] {
	return validateUnifiedContextManifestContract(manifest).map(
		(issue) => `${issue.path}: ${issue.message}`,
	);
}

describe("unified context manifest contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("emits a self-identifying contract with stable project-doc identities", () => {
		const before = loadUnifiedContextManifest(
			createWorkspace("maestro-before"),
			{
				includeMcpConfig: false,
			},
		);
		const after = loadUnifiedContextManifest(createWorkspace("maestro-after"), {
			includeMcpConfig: false,
		});

		expect(before.protocolVersion).toBe(UNIFIED_CONTEXT_MANIFEST_PROTOCOL);
		expect(issueMessages(before)).toEqual([]);
		expect(before.entries.map((entry) => entry.id)).toContain(
			"project_doc:project:AGENTS.md",
		);

		const diff = diffUnifiedContextManifests(before, after);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
		expect(diff.unchanged.map((entry) => entry.id)).toContain(
			"project_doc:project:AGENTS.md",
		);
	});

	it("reuses provided project docs without reloading them", () => {
		const workspace = createWorkspace("maestro-preloaded-project-docs");
		const loaderSpy = vi.spyOn(configModule, "loadPromptProjectDocManifest");
		const projectDocs = configModule.loadPromptProjectDocManifest(workspace);

		loaderSpy.mockClear();
		const manifest = loadUnifiedContextManifest(workspace, {
			includeMcpConfig: false,
			projectDocs,
		});

		expect(loaderSpy).not.toHaveBeenCalled();
		expect(manifest.projectDocs).toBe(projectDocs);
		expect(issueMessages(manifest)).toEqual([]);
	});

	it("redacts secret-bearing MCP config and runtime metadata", () => {
		const configManifest = loadUnifiedContextManifest(
			createWorkspace("maestro-mcp-config"),
			{
				mcpConfig: {
					servers: [
						{
							name: "stdio-secret",
							transport: "stdio",
							command: "/secret/bin/server",
							args: ["--token", "super-secret-token"],
							cwd: "/private/workspace",
							env: { API_TOKEN: "super-secret-env" },
							headersHelper: "print-secret-headers",
						},
					],
					authPresets: [],
				},
			},
		);
		const runtimeManifest = loadUnifiedContextManifest(
			createWorkspace("maestro-mcp-runtime"),
			{
				mcpStatus: {
					servers: [
						{
							name: "remote-secret",
							connected: false,
							error: "remote-secret-error",
							transport: "http",
							tools: [],
							resources: [],
							prompts: [],
							remoteUrl: "https://token.example.com/private-path",
							headerKeys: ["Authorization"],
							headersHelper: "print-runtime-headers",
						},
					],
					authPresets: [],
				},
			},
		);

		const serialized = JSON.stringify([configManifest, runtimeManifest]);
		expect(issueMessages(configManifest)).toEqual([]);
		expect(issueMessages(runtimeManifest)).toEqual([]);
		expect(
			configManifest.entries.some(
				(entry) => entry.kind === "mcp_server" && entry.metadata?.command,
			),
		).toBe(true);
		expect(
			runtimeManifest.entries.some(
				(entry) => entry.kind === "mcp_server" && entry.metadata?.error,
			),
		).toBe(true);
		expect(serialized).not.toContain("super-secret-token");
		expect(serialized).not.toContain("super-secret-env");
		expect(serialized).not.toContain("/secret/bin/server");
		expect(serialized).not.toContain("/private/workspace");
		expect(serialized).not.toContain("print-secret-headers");
		expect(serialized).not.toContain("print-runtime-headers");
		expect(serialized).not.toContain("remote-secret-error");
		expect(serialized).not.toContain("/private-path");
		expect(serialized).toContain("token.example.com");
	});

	it("reports raw MCP metadata and duplicate entry identities", () => {
		const manifest = loadUnifiedContextManifest(
			createWorkspace("maestro-bad"),
			{
				includeMcpConfig: false,
			},
		);
		const projectDoc = manifest.entries.find(
			(entry) => entry.kind === "project_doc",
		);
		expect(projectDoc).toBeDefined();
		manifest.entries.push(
			{
				id: projectDoc!.id,
				kind: "mcp_server",
				source: "mcp_config",
				status: "configured",
				label: "bad",
				metadata: {
					command: "/leaky/server",
					url: "https://secret.example.com/path",
					cwd: "/private",
				},
			},
			{
				id: "project_doc:project:/tmp/other/AGENTS.md",
				kind: "project_doc",
				source: "filesystem",
				status: "loaded",
				label: "AGENTS.md",
			},
		);

		expect(issueMessages(manifest)).toEqual(
			expect.arrayContaining([
				"entries[1].id: must be unique",
				"entries[1].metadata.cwd: is not allowed for mcp_server entries",
				"entries[1].metadata.command: must be summarized as a redacted object",
				"entries[1].metadata.url: must be summarized as a redacted URL object",
				"entries[2].id: must use a workspace-relative project document identity",
			]),
		);
	});
});
