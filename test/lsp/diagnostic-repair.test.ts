import { describe, expect, it } from "vitest";
import {
	buildDiagnosticDeltaToolSummary,
	buildDiagnosticRepairFollowUpMessage,
	formatDiagnosticDeltaForToolOutput,
	hasDiagnosticRepairOptOut,
} from "../../src/lsp/diagnostic-repair.js";
import type { LspDiagnostic } from "../../src/lsp/types.js";

function diagnostic(message: string, line: number): LspDiagnostic {
	return {
		message,
		severity: 1,
		source: "typescript",
		range: {
			start: { line, character: 2 },
			end: { line, character: 8 },
		},
	};
}

describe("diagnostic repair helpers", () => {
	it("builds structured repair metadata for introduced diagnostics", () => {
		const introduced = diagnostic("Type 'number' is not assignable", 4);
		const summary = buildDiagnosticDeltaToolSummary({
			file: "/repo/src/foo.ts",
			displayPath: "src/foo.ts",
			result: {
				allDiagnostics: { "/repo/src/foo.ts": [introduced] },
				fileDiagnostics: [introduced],
				newDiagnostics: [introduced],
				repairedDiagnostics: [],
				usedDelta: true,
				validatorDiagnostics: { "/repo/src/foo.ts": [introduced] },
			},
		});

		expect(summary.introducedCount).toBe(1);
		expect(summary.repair.shouldFollowUp).toBe(true);
		expect(summary.introducedDiagnostics[0]).toMatchObject({
			line: 5,
			column: 3,
			severityLabel: "error",
		});
		expect(formatDiagnosticDeltaForToolOutput(summary)).toContain(
			"Diagnostic delta: 1 introduced, 0 repaired, 1 remaining.",
		);
	});

	it("does not request self-repair when the baseline was unavailable", () => {
		const current = diagnostic("workspace diagnostic", 2);
		const summary = buildDiagnosticDeltaToolSummary({
			file: "/repo/src/foo.ts",
			displayPath: "src/foo.ts",
			result: {
				allDiagnostics: { "/repo/src/foo.ts": [current] },
				fileDiagnostics: [current],
				newDiagnostics: [current],
				repairedDiagnostics: [],
				usedDelta: false,
				validatorDiagnostics: { "/repo/src/foo.ts": [current] },
			},
		});

		expect(summary.repair.shouldFollowUp).toBe(false);
		expect(summary.repair.reason).toContain("baseline was unavailable");
	});

	it("builds a focused follow-up prompt for bounded repair", () => {
		const summary = buildDiagnosticDeltaToolSummary({
			file: "/repo/src/foo.ts",
			displayPath: "src/foo.ts",
			result: {
				allDiagnostics: {},
				fileDiagnostics: [diagnostic("new error", 0)],
				newDiagnostics: [diagnostic("new error", 0)],
				repairedDiagnostics: [],
				usedDelta: true,
				validatorDiagnostics: {},
			},
		});

		const message = buildDiagnosticRepairFollowUpMessage({
			summary,
			toolName: "edit",
			toolCallId: "call_1",
			attempt: 1,
		});

		expect(JSON.stringify(message.content)).toContain(
			"Automatic diagnostic repair attempt 1/2",
		);
		expect(JSON.stringify(message.content)).toContain(
			"Do not chase diagnostics that existed before this tool call",
		);
	});

	it("detects explicit user opt-out language", () => {
		expect(
			hasDiagnosticRepairOptOut([
				{
					role: "user",
					content: "Make this change but do not continue afterwards.",
					timestamp: Date.now(),
				},
			]),
		).toBe(true);
	});
});
