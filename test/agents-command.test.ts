import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAgentsInitPrompt,
	handleAgentsInit,
} from "../src/cli/commands/agents.js";

describe("handleAgentsInit", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
	});

	afterEach(() => {
		try {
			if (existsSync(tmpDir)) {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		} catch {
			// ignore cleanup errors
		}
	});

	it("creates AGENTS.md inside the target directory", () => {
		const path = handleAgentsInit(tmpDir);
		expect(path).toBe(join(tmpDir, "AGENTS.md"));
		const contents = readFileSync(path, "utf-8");
		expect(contents).toContain("# Repository Guidelines");
	});

	it("allows targeting a specific file path", () => {
		const customPath = join(tmpDir, "docs", "Team.md");
		const path = handleAgentsInit(customPath, { force: true });
		expect(path).toBe(customPath);
		const contents = readFileSync(path, "utf-8");
		expect(contents).toContain("docs");
	});

	it("throws when file exists unless force is provided", () => {
		const path = handleAgentsInit(tmpDir);
		expect(() => handleAgentsInit(path)).toThrow(/already exists/i);
		const forcedPath = handleAgentsInit(path, { force: true });
		expect(forcedPath).toBe(path);
	});

	it("builds a generation prompt with the target path", () => {
		const target = join(tmpDir, "AGENTS.md");
		const prompt = buildAgentsInitPrompt(target);
		expect(prompt).toContain("AGENTS.md");
		expect(prompt).toContain("Repository Guidelines");
	});
});
