import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
	diffUnifiedContextManifests,
	loadUnifiedContextManifest,
	validateUnifiedContextManifestContract,
	type UnifiedContextManifest,
} from "../src/context/manifest.js";

const tempDirs: string[] = [];

function workspace(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	writeFileSync(join(dir, "AGENTS.md"), "Stable guidance.\n");
	return dir;
}

function assert(condition: unknown, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function assertContract(manifest: UnifiedContextManifest): void {
	const issues = validateUnifiedContextManifestContract(manifest);
	if (issues.length > 0) {
		throw new Error(
			[
				"Unified context manifest contract failed:",
				...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
			].join("\n"),
		);
	}
}

function assertNoSecrets(serialized: string, secrets: string[]): void {
	for (const secret of secrets) {
		assert(
			!serialized.includes(secret),
			`manifest leaked secret-bearing value: ${secret}`,
		);
	}
}

try {
	const before = loadUnifiedContextManifest(workspace("manifest-before"), {
		includeMcpConfig: false,
	});
	const after = loadUnifiedContextManifest(workspace("manifest-after"), {
		includeMcpConfig: false,
	});
	assertContract(before);
	assert(before.protocolVersion === UNIFIED_CONTEXT_MANIFEST_PROTOCOL, "missing protocol version");
	assert(
		before.entries.some((entry) => entry.id === "project_doc:project:AGENTS.md"),
		"project document identity must be workspace-relative",
	);

	const diff = diffUnifiedContextManifests(before, after);
	assert(diff.added.length === 0, "same docs in a new workspace must not be added");
	assert(
		diff.removed.length === 0,
		"same docs in a new workspace must not be removed",
	);
	assert(
		diff.changed.length === 0,
		"absolute project-doc paths must not create drift",
	);

	const configManifest = loadUnifiedContextManifest(workspace("manifest-config"), {
		mcpConfig: {
			servers: [
				{
					name: "secret-config",
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
	});
	const runtimeManifest = loadUnifiedContextManifest(workspace("manifest-runtime"), {
		mcpStatus: {
			servers: [
				{
					name: "secret-runtime",
					connected: false,
					error: "remote-secret-error",
					transport: "http",
					tools: [],
					resources: [],
					prompts: [],
					command: "/runtime/secret/server",
					args: ["--runtime-token", "runtime-secret-token"],
					cwd: "/runtime/private/workspace",
					remoteUrl: "https://token.example.com/private-path",
					headerKeys: ["Authorization"],
					headersHelper: "print-runtime-headers",
				},
			],
			authPresets: [],
		},
	});
	assertContract(configManifest);
	assertContract(runtimeManifest);
	assertNoSecrets(JSON.stringify([configManifest, runtimeManifest]), [
		"/secret/bin/server",
		"super-secret-token",
		"super-secret-env",
		"/private/workspace",
		"print-secret-headers",
		"/runtime/secret/server",
		"runtime-secret-token",
		"/runtime/private/workspace",
		"print-runtime-headers",
		"remote-secret-error",
		"/private-path",
	]);

	console.log("Unified context manifest contract check passed.");
} finally {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
}
