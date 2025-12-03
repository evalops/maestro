import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the LSP module before importing tools
vi.mock("../../src/lsp/index.js", () => {
	return {
		collectDiagnostics: vi.fn(),
	};
});

// Import tools after mocking
import type { AgentToolResult } from "../../src/agent/types.js";
import { collectDiagnostics } from "../../src/lsp/index.js";
import { editTool } from "../../src/tools/edit.js";
import { writeTool } from "../../src/tools/write.js";

interface TextContent {
	type: "text";
	text: string;
}

function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

const mockCollectDiagnostics = vi.mocked(collectDiagnostics);

describe("The Law of Broken Windows (Tool Diagnostics)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "composer-broken-windows-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("writeTool appends diagnostics to output when errors exist", async () => {
		const filePath = join(testDir, "bad.ts");
		// absolute path used in tools
		const absolutePath = resolve(filePath);

		// Mock diagnostics return
		mockCollectDiagnostics.mockResolvedValue({
			[absolutePath]: [
				{
					message: "Expected expression",
					range: {
						start: { line: 0, character: 10 },
						end: { line: 0, character: 11 },
					},
					severity: 1,
					source: "ts",
				},
			],
		});

		const result = await writeTool.execute("write-1", {
			path: filePath,
			content: "const x = ;",
		});

		const output = getTextOutput(result);
		expect(output).toContain("Successfully wrote");
		expect(output).toContain("Linter check for");
		expect(output).toContain("Line 1: Expected expression");
	});

	it("writeTool does not append diagnostics if none found", async () => {
		const filePath = join(testDir, "good.ts");
		mockCollectDiagnostics.mockResolvedValue({});

		const result = await writeTool.execute("write-2", {
			path: filePath,
			content: "const x = 1;",
		});

		const output = getTextOutput(result);
		expect(output).toContain("Successfully wrote");
		expect(output).not.toContain("Linter check for");
	});

	it("editTool appends diagnostics to output", async () => {
		const filePath = join(testDir, "edit-bad.ts");
		const absolutePath = resolve(filePath);
		writeFileSync(filePath, "const x = 1;");

		mockCollectDiagnostics.mockResolvedValue({
			[absolutePath]: [
				{
					message: "Type error",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
					severity: 1,
				},
			],
		});

		const result = await editTool.execute("edit-1", {
			path: filePath,
			oldText: "1",
			newText: '"string"',
		});

		const output = getTextOutput(result);
		expect(output).toContain("Successfully edited");
		expect(output).toContain("Linter check for");
		expect(output).toContain("Line 1: Type error");
	});
});
