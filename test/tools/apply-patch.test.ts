import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { runValidatorsOnSuccess } from "../../src/safety/safe-mode.js";
import type { Sandbox } from "../../src/sandbox/types.js";
import {
	parseApplyPatch,
	parseApplyPatchPaths,
} from "../../src/tools/apply-patch-parser.js";
import {
	type ApplyPatchToolDetails,
	applyPatchTool,
} from "../../src/tools/apply-patch.js";
import type { ToolError } from "../../src/tools/tool-dsl.js";

vi.mock("../../src/safety/safe-mode.js", () => ({
	requirePlanCheck: vi.fn(),
	runValidatorsOnSuccess: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lsp/index.js", () => ({
	collectDiagnostics: vi.fn().mockResolvedValue({}),
}));

function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter(
				(c): c is { type: "text"; text: string } =>
					c.type === "text" && typeof c.text === "string",
			)
			.map((c) => c.text)
			.join("\n") || ""
	);
}

function details(result: AgentToolResult<unknown>): ApplyPatchToolDetails {
	return result.details as ApplyPatchToolDetails;
}

function createMemorySandbox(
	files: Record<string, string>,
	options: { failWritesFor?: Set<string>; delete?: true } = {},
): Sandbox {
	const contents = new Map(Object.entries(files));
	return {
		async exec() {
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		async readFile(path: string) {
			const content = contents.get(path);
			if (content === undefined) {
				throw new Error(`missing ${path}`);
			}
			return content;
		},
		async writeFile(path: string, content: string) {
			if (options.failWritesFor?.has(path)) {
				throw new Error(`write failed for ${path}`);
			}
			contents.set(path, content);
		},
		async exists(path: string) {
			return contents.has(path);
		},
		...(options.delete
			? {
					async delete(path: string) {
						contents.delete(path);
					},
				}
			: {}),
		async dispose() {},
	};
}

describe("apply_patch parser", () => {
	it("parses add, update, and delete operations", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+export const answer = 42;",
			"*** Update File: src/existing.ts",
			"@@",
			" export function name() {",
			"-  return 'old';",
			"+  return 'new';",
			" }",
			"*** Delete File: src/remove.ts",
			"*** End Patch",
		].join("\n");

		expect(parseApplyPatchPaths(patch)).toEqual([
			"src/new.ts",
			"src/existing.ts",
			"src/remove.ts",
		]);
		expect(parseApplyPatch(patch).operations).toHaveLength(3);
	});

	it("parses move headers and includes both source and destination paths", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"*** End Patch",
		].join("\n");

		expect(parseApplyPatchPaths(patch)).toEqual(["src/old.ts", "src/new.ts"]);
		expect(parseApplyPatch(patch).operations).toEqual([
			{
				type: "update",
				path: "src/old.ts",
				moveTo: "src/new.ts",
				hunks: [],
			},
		]);
	});

	it("rejects empty add-file hunks", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/empty.ts",
			"*** End Patch",
		].join("\n");

		expect(() => parseApplyPatch(patch)).toThrow(
			"Add File src/empty.ts must contain at least one line",
		);
	});
});

describe("apply_patch tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "apply-patch-tool-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("updates an existing file and reports apply_patch details", async () => {
		const filePath = join(testDir, "example.ts");
		writeFileSync(filePath, "const value = 1;\nconsole.log(value);\n");

		const result = await applyPatchTool.execute("call-1", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				" const value = 1;",
				"-console.log(value);",
				"+console.log(value + 1);",
				"*** End Patch",
			].join("\n"),
		});

		expect(getTextOutput(result)).toContain("Applied patch to 1 file(s)");
		expect(readFileSync(filePath, "utf-8")).toBe(
			"const value = 1;\nconsole.log(value + 1);\n",
		);
		expect(details(result)).toMatchObject({
			filesModified: [filePath],
			filesCreated: [],
			filesDeleted: [],
			hunksApplied: 1,
			hunksFailed: 0,
			editGrammar: "apply_patch",
		});
		expect(runValidatorsOnSuccess).toHaveBeenCalledWith([filePath], {
			[filePath]: [],
		});
	});

	it("applies repeated filesystem operations against staged patch state", async () => {
		const filePath = join(testDir, "repeated.ts");
		writeFileSync(filePath, "export const a = 1;\nexport const b = 1;\n");

		const result = await applyPatchTool.execute("call-repeated", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				"-export const a = 1;",
				"+export const a = 2;",
				`*** Update File: ${filePath}`,
				"@@",
				"-export const b = 1;",
				"+export const b = 2;",
				"*** End Patch",
			].join("\n"),
		});

		expect(readFileSync(filePath, "utf-8")).toBe(
			"export const a = 2;\nexport const b = 2;\n",
		);
		expect(getTextOutput(result)).toContain("Applied patch to 1 file(s)");
	});

	it("honors EOF newline markers when adding a final newline", async () => {
		const filePath = join(testDir, "missing-final-newline.txt");
		writeFileSync(filePath, "old");

		await applyPatchTool.execute("call-eof-add-newline", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				"-old",
				"\\ No newline at end of file",
				"+new",
				"*** End Patch",
			].join("\n"),
		});

		expect(readFileSync(filePath, "utf-8")).toBe("new\n");
	});

	it("honors EOF newline markers when removing a final newline", async () => {
		const filePath = join(testDir, "remove-final-newline.txt");
		writeFileSync(filePath, "old\n");

		await applyPatchTool.execute("call-eof-remove-newline", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				"-old",
				"+new",
				"\\ No newline at end of file",
				"*** End Patch",
			].join("\n"),
		});

		expect(readFileSync(filePath, "utf-8")).toBe("new");
	});

	it("adds and deletes files", async () => {
		const addedPath = join(testDir, "nested", "created.py");
		const deletedPath = join(testDir, "old.rs");
		writeFileSync(deletedPath, "fn main() {}\n");

		const result = await applyPatchTool.execute("call-2", {
			patch: [
				"*** Begin Patch",
				`*** Add File: ${addedPath}`,
				"+def main():",
				"+    return 1",
				`*** Delete File: ${deletedPath}`,
				"*** End Patch",
			].join("\n"),
		});

		expect(readFileSync(addedPath, "utf-8")).toBe(
			"def main():\n    return 1\n",
		);
		expect(existsSync(deletedPath)).toBe(false);
		expect(details(result)).toMatchObject({
			filesCreated: [addedPath],
			filesDeleted: [deletedPath],
			hunksApplied: 2,
		});
	});

	it("rejects adding over an existing non-file path", async () => {
		const existingDir = join(testDir, "existing-dir");
		mkdirSync(existingDir);

		await expect(
			applyPatchTool.execute("call-add-existing-dir", {
				patch: [
					"*** Begin Patch",
					`*** Add File: ${existingDir}`,
					"+content",
					"*** End Patch",
				].join("\n"),
			}),
		).rejects.toThrow(`File already exists: ${existingDir}`);
	});

	it("moves a file while applying update hunks", async () => {
		const sourcePath = join(testDir, "source.ts");
		const destinationPath = join(testDir, "destination.ts");
		writeFileSync(sourcePath, "export const label = 'old';\n");

		const result = await applyPatchTool.execute("call-move", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${sourcePath}`,
				`*** Move to: ${destinationPath}`,
				"@@",
				"-export const label = 'old';",
				"+export const label = 'new';",
				"*** End Patch",
			].join("\n"),
		});

		expect(existsSync(sourcePath)).toBe(false);
		expect(readFileSync(destinationPath, "utf-8")).toBe(
			"export const label = 'new';\n",
		);
		expect(details(result)).toMatchObject({
			filesCreated: [destinationPath],
			filesDeleted: [sourcePath],
			hunksApplied: 1,
		});
	});

	it("appends insertion-only update hunks", async () => {
		const filePath = join(testDir, "insert-only.txt");
		writeFileSync(filePath, "first\n");

		await applyPatchTool.execute("call-insert-only", {
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				"+second",
				"*** End Patch",
			].join("\n"),
		});

		expect(readFileSync(filePath, "utf-8")).toBe("first\nsecond\n");
	});

	it("rolls back earlier filesystem writes when a later write fails", async () => {
		const firstPath = join(testDir, "first.txt");
		const parentFilePath = join(testDir, "parent-file");
		const blockedPath = join(parentFilePath, "child.txt");
		writeFileSync(firstPath, "old\n");
		writeFileSync(parentFilePath, "not a directory\n");

		await expect(
			applyPatchTool.execute("call-rollback", {
				patch: [
					"*** Begin Patch",
					`*** Update File: ${firstPath}`,
					"@@",
					"-old",
					"+new",
					`*** Add File: ${blockedPath}`,
					"+blocked",
					"*** End Patch",
				].join("\n"),
			}),
		).rejects.toThrow();

		expect(readFileSync(firstPath, "utf-8")).toBe("old\n");
	});

	it("supports dry runs without writing", async () => {
		const filePath = join(testDir, "dry-run.md");
		writeFileSync(filePath, "hello\n");

		const result = await applyPatchTool.execute("call-3", {
			dryRun: true,
			patch: [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@",
				"-hello",
				"+goodbye",
				"*** End Patch",
			].join("\n"),
		});

		expect(getTextOutput(result)).toContain("Dry run");
		expect(readFileSync(filePath, "utf-8")).toBe("hello\n");
		expect(runValidatorsOnSuccess).not.toHaveBeenCalled();
	});

	it("rolls back earlier writes when a later filesystem write fails", async () => {
		const firstPath = join(testDir, "first.ts");
		const blockedDir = join(testDir, "blocked");
		const blockedPath = join(blockedDir, "created.ts");
		writeFileSync(firstPath, "export const first = 1;\n");
		mkdirSync(blockedDir);

		try {
			chmodSync(blockedDir, 0o500);

			await expect(
				applyPatchTool.execute("call-rollback", {
					patch: [
						"*** Begin Patch",
						`*** Update File: ${firstPath}`,
						"@@",
						"-export const first = 1;",
						"+export const first = 2;",
						`*** Add File: ${blockedPath}`,
						"+export const blocked = true;",
						"*** End Patch",
					].join("\n"),
				}),
			).rejects.toThrow();
		} finally {
			chmodSync(blockedDir, 0o700);
		}

		expect(readFileSync(firstPath, "utf-8")).toBe("export const first = 1;\n");
		expect(existsSync(blockedPath)).toBe(false);
	});

	it("rolls back earlier sandbox writes when a later sandbox write fails", async () => {
		const sandbox = createMemorySandbox(
			{
				"first.ts": "export const first = 1;\n",
				"second.ts": "export const second = 1;\n",
			},
			{ failWritesFor: new Set(["second.ts"]) },
		);

		await expect(
			applyPatchTool.execute(
				"call-sandbox-rollback",
				{
					patch: [
						"*** Begin Patch",
						"*** Update File: first.ts",
						"@@",
						"-export const first = 1;",
						"+export const first = 2;",
						"*** Update File: second.ts",
						"@@",
						"-export const second = 1;",
						"+export const second = 2;",
						"*** End Patch",
					].join("\n"),
				},
				undefined,
				{ sandbox },
			),
		).rejects.toThrow("write failed for second.ts");

		await expect(sandbox.readFile("first.ts")).resolves.toBe(
			"export const first = 1;\n",
		);
		await expect(sandbox.readFile("second.ts")).resolves.toBe(
			"export const second = 1;\n",
		);
	});

	it("applies repeated sandbox operations against staged patch state", async () => {
		const sandbox = createMemorySandbox({
			"repeated.ts": "export const a = 1;\nexport const b = 1;\n",
		});

		await applyPatchTool.execute(
			"call-sandbox-repeated",
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: repeated.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
					"*** Update File: repeated.ts",
					"@@",
					"-export const b = 1;",
					"+export const b = 2;",
					"*** End Patch",
				].join("\n"),
			},
			undefined,
			{ sandbox },
		);

		await expect(sandbox.readFile("repeated.ts")).resolves.toBe(
			"export const a = 2;\nexport const b = 2;\n",
		);
	});

	it("prevents unsafe sandbox add or delete patches when rollback deletes are unavailable", async () => {
		const sandbox = createMemorySandbox({
			"first.ts": "export const first = 1;\n",
			"second.ts": "export const second = 1;\n",
		});

		await expect(
			applyPatchTool.execute(
				"call-sandbox-no-delete",
				{
					patch: [
						"*** Begin Patch",
						"*** Update File: first.ts",
						"@@",
						"-export const first = 1;",
						"+export const first = 2;",
						"*** Delete File: second.ts",
						"*** End Patch",
					].join("\n"),
				},
				undefined,
				{ sandbox },
			),
		).rejects.toThrow("cannot safely apply add/delete operations");

		await expect(sandbox.readFile("first.ts")).resolves.toBe(
			"export const first = 1;\n",
		);
		await expect(sandbox.readFile("second.ts")).resolves.toBe(
			"export const second = 1;\n",
		);
	});

	it("formats sandbox missing-file errors with a readable location", async () => {
		const sandbox = createMemorySandbox({});

		await expect(
			applyPatchTool.execute(
				"call-sandbox-missing",
				{
					patch: [
						"*** Begin Patch",
						"*** Update File: missing.ts",
						"@@",
						"-old",
						"+new",
						"*** End Patch",
					].join("\n"),
				},
				undefined,
				{ sandbox },
			),
		).rejects.toThrow("File not found in sandbox: missing.ts");
	});

	it("throws a retryable ToolError with conflict details for failed hunks", async () => {
		const filePath = join(testDir, "stale.ts");
		writeFileSync(filePath, "const fresh = true;\n");

		await expect(
			applyPatchTool.execute("call-4", {
				patch: [
					"*** Begin Patch",
					`*** Update File: ${filePath}`,
					"@@",
					"-const stale = true;",
					"+const stale = false;",
					"*** End Patch",
				].join("\n"),
			}),
		).rejects.toMatchObject({
			name: "ToolError",
			code: "APPLY_PATCH_CONFLICT",
			details: {
				filesModified: [],
				hunksApplied: 0,
				hunksFailed: 1,
				editGrammar: "apply_patch",
			},
		} satisfies Partial<ToolError>);
		expect(readFileSync(filePath, "utf-8")).toBe("const fresh = true;\n");
	});

	it("applies a 20-case representative patch fixture set", async () => {
		const cases = [
			[
				"alpha.ts",
				"export const a = 1;\n",
				"-export const a = 1;",
				"+export const a = 2;",
			],
			[
				"bravo.tsx",
				"return <span>old</span>;\n",
				"-return <span>old</span>;",
				"+return <span>new</span>;",
			],
			[
				"charlie.js",
				"module.exports = 1;\n",
				"-module.exports = 1;",
				"+module.exports = 2;",
			],
			[
				"delta.mjs",
				"export default 'old';\n",
				"-export default 'old';",
				"+export default 'new';",
			],
			["echo.py", "value = 1\n", "-value = 1", "+value = 2"],
			["foxtrot.py", "print('old')\n", "-print('old')", "+print('new')"],
			["golf.rs", "let value = 1;\n", "-let value = 1;", "+let value = 2;"],
			[
				"hotel.rs",
				'println!("old");\n',
				'-println!("old");',
				'+println!("new");',
			],
			["india.go", "value := 1\n", "-value := 1", "+value := 2"],
			[
				"juliet.go",
				'fmt.Println("old")\n',
				'-fmt.Println("old")',
				'+fmt.Println("new")',
			],
			["kilo.md", "# Old\n", "-# Old", "+# New"],
			["lima.md", "- old\n", "-- old", "+- new"],
			[
				"mike.json",
				'{"enabled": false}\n',
				'-{"enabled": false}',
				'+{"enabled": true}',
			],
			[
				"november.yaml",
				"enabled: false\n",
				"-enabled: false",
				"+enabled: true",
			],
			[
				"oscar.css",
				".btn { color: red; }\n",
				"-.btn { color: red; }",
				"+.btn { color: blue; }",
			],
			["papa.scss", "$gap: 4px;\n", "-$gap: 4px;", "+$gap: 8px;"],
			["quebec.sql", "select 1;\n", "-select 1;", "+select 2;"],
			["romeo.sh", "echo old\n", "-echo old", "+echo new"],
			[
				"sierra.toml",
				"enabled = false\n",
				"-enabled = false",
				"+enabled = true",
			],
			["tango.txt", "old\n", "-old", "+new"],
		] as const;

		for (const [name, before, removeLine, addLine] of cases) {
			const filePath = join(testDir, name);
			writeFileSync(filePath, before);
			const result = await applyPatchTool.execute(`fixture-${name}`, {
				patch: [
					"*** Begin Patch",
					`*** Update File: ${filePath}`,
					"@@",
					removeLine,
					addLine,
					"*** End Patch",
				].join("\n"),
			});
			expect(details(result).hunksApplied).toBe(1);
		}
	});
});
