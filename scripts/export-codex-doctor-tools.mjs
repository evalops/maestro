#!/usr/bin/env node
/**
 * Export codingTools + Codex tool profiles for native `maestro codex doctor`.
 *
 * Writes test/fixtures/codex/coding-tools-doctor-v1.json (live parameter schemas
 * from the TypeScript tool registry). Run with --check to verify the committed
 * fixture matches the current registry.
 *
 * Usage:
 *   node scripts/export-codex-doctor-tools.mjs
 *   node scripts/export-codex-doctor-tools.mjs --check
 *   bun scripts/export-codex-doctor-tools.mjs
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(
	rootDir,
	"test/fixtures/codex/coding-tools-doctor-v1.json",
);
const check = process.argv.includes("--check");

function buildExportSource() {
	const toolsModule = resolve(rootDir, "src/tools/index.ts");
	const profilesModule = resolve(rootDir, "src/codex/compatibility.ts");
	// Absolute file URLs keep the temp worker portable across bun/tsx.
	const toolsUrl = new URL(`file://${toolsModule}`).href;
	const profilesUrl = new URL(`file://${profilesModule}`).href;
	return `import { writeFileSync } from "node:fs";
import { codingTools } from ${JSON.stringify(toolsUrl)};
import { CODEX_TOOL_PROFILES } from ${JSON.stringify(profilesUrl)};

function stableJson(value) {
	return \`\${JSON.stringify(value, null, "\\t")}\\n\`;
}

const tools = codingTools.map((tool) => {
	const entry = {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters ?? {})),
	};
	if (tool.deferApiDefinition) {
		entry.deferApiDefinition = true;
	}
	if (tool.executionLocation) {
		entry.executionLocation = tool.executionLocation;
	}
	return entry;
});

const profiles = {};
for (const [name, toolNames] of Object.entries(CODEX_TOOL_PROFILES)) {
	profiles[name] = [...toolNames];
}

const fixture = {
	version: 1,
	source: {
		codingTools: "src/tools/index.ts",
		profiles: "src/codex/compatibility.ts",
	},
	tools,
	profiles,
};

writeFileSync(process.argv[2], stableJson(fixture), "utf8");
`;
}

function resolveRunner() {
	const bun = join(rootDir, "node_modules", ".bin", "bun");
	if (existsSync(bun)) {
		return { command: bun, label: "bun" };
	}
	const whichBun = spawnSync("bun", ["--version"], { encoding: "utf8" });
	if (whichBun.status === 0) {
		return { command: "bun", label: "bun" };
	}
	const tsx = join(rootDir, "node_modules", ".bin", "tsx");
	if (existsSync(tsx)) {
		return { command: tsx, label: "tsx" };
	}
	const whichTsx = spawnSync("tsx", ["--version"], { encoding: "utf8" });
	if (whichTsx.status === 0) {
		return { command: "tsx", label: "tsx" };
	}
	throw new Error(
		"export-codex-doctor-tools requires bun or tsx to load TypeScript sources",
	);
}

function formatFixture(source) {
	const biome = join(rootDir, "node_modules", ".bin", "biome");
	if (!existsSync(biome)) {
		throw new Error(
			"export-codex-doctor-tools requires the workspace Biome binary",
		);
	}
	const result = spawnSync(
		biome,
		["format", "--stdin-file-path", fixturePath],
		{
			cwd: rootDir,
			encoding: "utf8",
			input: source,
		},
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const detail = result.stderr || result.stdout || `exit ${result.status}`;
		throw new Error(`Failed to format Codex doctor tools fixture: ${detail}`);
	}
	return result.stdout;
}

function exportFixture() {
	const runner = resolveRunner();
	const tempDir = mkdtempSync(join(tmpdir(), "codex-doctor-tools-"));
	const exporterPath = join(tempDir, "export-codex-doctor-tools-worker.ts");
	const outputPath = join(tempDir, "coding-tools-doctor-v1.json");
	try {
		writeFileSync(exporterPath, buildExportSource(), "utf8");
		const result = spawnSync(runner.command, [exporterPath, outputPath], {
			cwd: rootDir,
			encoding: "utf8",
			env: process.env,
		});
		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			const detail = result.stderr || result.stdout || `exit ${result.status}`;
			throw new Error(
				`Failed to export Codex doctor tools via ${runner.label}: ${detail}`,
			);
		}
		return formatFixture(readFileSync(outputPath, "utf8"));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function main() {
	const next = exportFixture();
	if (check) {
		const current = existsSync(fixturePath)
			? readFileSync(fixturePath, "utf8")
			: null;
		if (current !== next) {
			console.error(
				`Codex doctor tools fixture is out of date: ${fixturePath}\n` +
					"Run: node scripts/export-codex-doctor-tools.mjs",
			);
			process.exitCode = 1;
			return;
		}
		console.log("Codex doctor tools fixture is up to date");
		return;
	}

	writeFileSync(fixturePath, next, "utf8");
	const parsed = JSON.parse(next);
	console.log(
		`Wrote ${fixturePath} (${parsed.tools.length} tools, ${Object.keys(parsed.profiles).length} profiles)`,
	);
}

main();
