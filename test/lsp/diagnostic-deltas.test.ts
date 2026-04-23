import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	diagnosticsForFile,
	diffDiagnostics,
} from "../../src/lsp/diagnostic-deltas.js";
import type { LspDiagnostic } from "../../src/lsp/types.js";

function diagnostic(
	message: string,
	line: number,
	severity: LspDiagnostic["severity"] = 1,
	source = "typescript",
): LspDiagnostic {
	return {
		message,
		severity,
		source,
		range: {
			start: { line, character: 0 },
			end: { line, character: 8 },
		},
	};
}

describe("diagnostic deltas", () => {
	it("returns only diagnostics introduced after a baseline", () => {
		const existing = diagnostic("pre-existing error", 2);
		const introduced = diagnostic("new error", 4);

		expect(diffDiagnostics([existing], [existing, introduced])).toEqual([
			introduced,
		]);
	});

	it("returns diagnostics removed by a later state when arguments are reversed", () => {
		const repaired = diagnostic("fixed error", 2);
		const stillPresent = diagnostic("remaining error", 4);

		expect(diffDiagnostics([stillPresent], [repaired, stillPresent])).toEqual([
			repaired,
		]);
	});

	it("treats duplicate diagnostics as a multiset", () => {
		const repeated = diagnostic("same error at same range", 7);

		expect(diffDiagnostics([repeated], [repeated, repeated])).toEqual([
			repeated,
		]);
	});

	it("matches diagnostics keyed by file URI or absolute path", () => {
		const file = "/tmp/maestro-diagnostic-delta.ts";
		const entry = diagnostic("uri keyed diagnostic", 1);

		expect(
			diagnosticsForFile(
				{
					[pathToFileURL(file).toString()]: [entry],
				},
				file,
			),
		).toEqual([entry]);
	});
});
