import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers = ["1", "1", "n"];
const questionMock = vi.fn(async () => answers.shift() ?? "");
const closeMock = vi.fn();

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: questionMock,
		close: closeMock,
	})),
}));

describe("handleConfigInit", () => {
	const originalCwd = process.cwd();
	const originalLog = console.log;
	let tempDir: string;
	let output: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "maestro-config-init-"));
		process.chdir(tempDir);
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		answers.splice(0, answers.length, "1", "1", "n");
		questionMock.mockClear();
		closeMock.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		console.log = originalLog;
		rmSync(tempDir, { recursive: true, force: true });
		vi.resetModules();
	});

	it("writes maestro-branded env guidance and next steps", async () => {
		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const envExample = readFileSync(join(tempDir, ".env.example"), "utf8");
		expect(envExample).toContain("# Maestro Configuration");
		expect(envExample).not.toContain("# Composer Configuration");

		const combined = output.join("\n");
		expect(combined).toContain("Run: maestro models list");
		expect(combined).toContain('Start using: maestro "your prompt"');
		expect(combined).not.toContain("Run: composer models list");
		expect(combined).not.toContain('Start using: composer "your prompt"');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});
