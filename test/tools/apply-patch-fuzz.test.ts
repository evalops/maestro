import { describe, expect, it, vi } from "vitest";

import fc from "fast-check";

import type { Sandbox } from "../../src/sandbox/types.js";
import {
	parseApplyPatch,
	parseApplyPatchPaths,
} from "../../src/tools/apply-patch-parser.js";
import { applyPatchTool } from "../../src/tools/apply-patch.js";
import { makeApplyPatchFuzzCase } from "./apply-patch-fuzz-cases.js";

vi.mock("../../src/safety/safe-mode.js", () => ({
	requirePlanCheck: vi.fn(),
	runValidatorsOnSuccess: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lsp/index.js", () => ({
	collectDiagnostics: vi.fn().mockResolvedValue({}),
}));

describe("apply_patch fuzz/conformance", () => {
	it("applies generated staged sandbox patches against the model", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.nat(5000), { minLength: 1, maxLength: 80 }),
				async (choices) => {
					const fuzzCase = makeApplyPatchFuzzCase(choices);
					const sandbox = createMemorySandbox(fuzzCase.initialFiles);

					const result = await applyPatchTool.execute(
						`fuzz-${choices.join("-")}`,
						{ patch: fuzzCase.patch },
						undefined,
						{ sandbox },
					);

					expect(result.details).toMatchObject({
						editGrammar: "apply_patch",
						hunksFailed: 0,
					});
					expect(
						parseApplyPatch(fuzzCase.patch).operations.length,
					).toBeGreaterThan(0);
					expect(parseApplyPatchPaths(fuzzCase.patch)).toEqual(
						fuzzCase.expectedTouchedPaths,
					);
					expect(await sandbox.snapshot()).toEqual(fuzzCase.expectedFiles);
				},
			),
			{
				numRuns: 100,
				seed: 0x5eed,
			},
		);
	});

	it("extracts every generated operation path exactly once in document order", () => {
		const safeSegment = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
				minLength: 1,
				maxLength: 8,
			})
			.map((chars) => chars.join(""))
			.filter((segment) => /^[a-z]/.test(segment));
		const pathArb = fc
			.array(safeSegment, { minLength: 1, maxLength: 4 })
			.map((segments) => `${segments.join("/")}.txt`);
		const operationArb = fc.oneof(
			pathArb.map((path) => ({
				paths: [path],
				lines: [`*** Add File: ${path}`, "+created"],
			})),
			pathArb.map((path) => ({
				paths: [path],
				lines: [`*** Delete File: ${path}`],
			})),
			pathArb.map((path) => ({
				paths: [path],
				lines: [`*** Update File: ${path}`, "@@", "-old", "+new"],
			})),
			fc
				.tuple(pathArb, pathArb)
				.filter(([source, destination]) => source !== destination)
				.map(([source, destination]) => ({
					paths: [source, destination],
					lines: [
						`*** Update File: ${source}`,
						`*** Move to: ${destination}`,
						"@@",
						"-old",
						"+new",
					],
				})),
		);

		fc.assert(
			fc.property(
				fc.array(operationArb, { minLength: 1, maxLength: 50 }),
				(operations) => {
					const patch = [
						"*** Begin Patch",
						...operations.flatMap((operation) => operation.lines),
						"*** End Patch",
					].join("\n");
					const expectedPaths = [
						...new Set(operations.flatMap((operation) => operation.paths)),
					];

					expect(parseApplyPatchPaths(patch)).toEqual(expectedPaths);
					expect(parseApplyPatch(patch).operations).toHaveLength(
						operations.length,
					);
				},
			),
			{
				numRuns: 100,
				seed: 0xc0de,
			},
		);
	});

	it("fails closed when generated malformed operation headers hide paths", () => {
		const dangerousPathArb = fc.constantFrom(
			"/etc/profile",
			"/usr/local/bin/bootstrap",
			"/var/lib/systemd/unit.service",
			"C:\\Windows\\System32\\drivers\\etc\\hosts",
			"~/.ssh/authorized_keys",
		);
		const malformedHeaderArb = fc
			.tuple(
				fc.constantFrom(
					"*** Add File:",
					"*** Update File:",
					"*** Delete File:",
					"*** Move to:",
				),
				dangerousPathArb,
			)
			.map(([header, path]) =>
				[
					"*** Begin Patch",
					`${header}${path}`,
					"+payload",
					"*** End Patch",
				].join("\n"),
			);

		fc.assert(
			fc.property(malformedHeaderArb, (patch) => {
				expect(() => parseApplyPatch(patch)).toThrow();
				expect(parseApplyPatchPaths(patch)).toEqual([]);
			}),
			{
				numRuns: 50,
				seed: 0xabad1dea,
			},
		);
	});
});

function createMemorySandbox(files: Record<string, string>): Sandbox & {
	snapshot(): Promise<Record<string, string>>;
} {
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
			contents.set(path, content);
		},
		async exists(path: string) {
			return contents.has(path);
		},
		async delete(path: string) {
			contents.delete(path);
		},
		async dispose() {},
		async snapshot() {
			return Object.fromEntries(
				[...contents.entries()].sort(([left], [right]) =>
					left.localeCompare(right),
				),
			);
		},
	};
}
