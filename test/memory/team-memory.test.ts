import { execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("team memory", () => {
	let tempRoot: string;
	let originalMaestroHome: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-team-memory-"));
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalCwd = process.cwd();
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
		process.chdir(tempRoot);
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function initRepo(root: string): void {
		execSync("git init -q", { cwd: root, stdio: "ignore" });
	}

	it("returns null outside a git repository", async () => {
		const teamMemory = await import("../../src/memory/team-memory.js");

		expect(teamMemory.getTeamMemoryLocation(tempRoot)).toBeNull();
		expect(teamMemory.getTeamMemoryStatus(tempRoot)).toBeNull();
		expect(teamMemory.buildTeamMemoryPromptContext(tempRoot)).toBeNull();
	});

	it("creates the repo-scoped entrypoint and reports status", async () => {
		initRepo(tempRoot);
		const teamMemory = await import("../../src/memory/team-memory.js");

		const location = teamMemory.ensureTeamMemoryEntrypoint(tempRoot);
		expect(location).not.toBeNull();
		expect(existsSync(location!.entrypoint)).toBe(true);
		expect(readFileSync(location!.entrypoint, "utf-8")).toContain(
			"# Team Memory",
		);

		const status = teamMemory.getTeamMemoryStatus(tempRoot);
		expect(status).toMatchObject({
			exists: true,
			fileCount: 1,
			files: ["MEMORY.md"],
		});
	});

	it("builds prompt context from repo-scoped memory files", async () => {
		initRepo(tempRoot);
		const teamMemory = await import("../../src/memory/team-memory.js");

		const location = teamMemory.ensureTeamMemoryEntrypoint(tempRoot)!;
		writeFileSync(
			join(location.directory, "deploy.md"),
			"Deploy with bun run release after green CI.",
			"utf-8",
		);

		const context = teamMemory.buildTeamMemoryPromptContext(tempRoot);

		expect(context).toContain("# Team Memory");
		expect(context).toContain("## MEMORY.md");
		expect(context).toContain("## deploy.md");
		expect(context).toContain("Deploy with bun run release after green CI.");
	});

	it("blocks high-confidence secrets in team-memory files", async () => {
		initRepo(tempRoot);
		const teamMemory = await import("../../src/memory/team-memory.js");

		const location = teamMemory.ensureTeamMemoryEntrypoint(tempRoot)!;
		const anthropicKey = `sk-ant-${"a".repeat(24)}`;

		expect(() =>
			teamMemory.assertTeamMemoryContentSafe(
				location.entrypoint,
				`Anthropic key: ${anthropicKey}`,
			),
		).toThrow("Potential secrets detected");
	});
});
