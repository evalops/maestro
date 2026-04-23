import { createHash } from "node:crypto";
import type { AppMessage, ToolResultMessage } from "../agent/types.js";
import type { DiagnosticDeltaResult } from "./diagnostic-deltas.js";
import type { LspDiagnostic } from "./types.js";

export const DIAGNOSTIC_REPAIR_MAX_ATTEMPTS = 2;

export type StructuredDiagnosticDeltaDiagnostic = {
	message: string;
	severity: LspDiagnostic["severity"];
	severityLabel: "error" | "warning" | "information" | "hint" | "unknown";
	source?: string;
	line: number;
	column: number;
	range: LspDiagnostic["range"];
};

export type DiagnosticDeltaToolSummary = {
	kind: "diagnostic_delta";
	file: string;
	displayPath: string;
	usedDelta: boolean;
	introducedCount: number;
	repairedCount: number;
	remainingCount: number;
	fingerprint: string;
	introducedDiagnostics: StructuredDiagnosticDeltaDiagnostic[];
	repairedDiagnostics: StructuredDiagnosticDeltaDiagnostic[];
	repair: {
		shouldFollowUp: boolean;
		maxAttempts: number;
		reason: string;
	};
};

export type DiagnosticDeltaDetails = {
	diagnosticDelta?: DiagnosticDeltaToolSummary;
};

export function buildDiagnosticDeltaToolSummary({
	file,
	displayPath,
	result,
}: {
	file: string;
	displayPath: string;
	result: DiagnosticDeltaResult;
}): DiagnosticDeltaToolSummary {
	const introducedDiagnostics = result.newDiagnostics.map(structureDiagnostic);
	const repairedDiagnostics =
		result.repairedDiagnostics.map(structureDiagnostic);
	const introducedCount = introducedDiagnostics.length;
	const repairedCount = repairedDiagnostics.length;
	const remainingCount = result.fileDiagnostics.length;

	return {
		kind: "diagnostic_delta",
		file,
		displayPath,
		usedDelta: result.usedDelta,
		introducedCount,
		repairedCount,
		remainingCount,
		fingerprint: fingerprintDiagnostics(result.newDiagnostics),
		introducedDiagnostics,
		repairedDiagnostics,
		repair: {
			shouldFollowUp: result.usedDelta && introducedCount > 0,
			maxAttempts: DIAGNOSTIC_REPAIR_MAX_ATTEMPTS,
			reason: result.usedDelta
				? "New diagnostics were introduced by this tool call."
				: "Diagnostic baseline was unavailable, so diagnostics are not treated as agent-caused.",
		},
	};
}

export function formatDiagnosticDeltaForToolOutput(
	summary: DiagnosticDeltaToolSummary,
): string {
	if (summary.introducedCount === 0 && summary.repairedCount === 0) {
		return "";
	}

	const lines = [
		`Diagnostic delta: ${summary.introducedCount} introduced, ${summary.repairedCount} repaired, ${summary.remainingCount} remaining.`,
	];

	if (summary.repair.shouldFollowUp) {
		lines.push(
			`Self-repair guidance: treat only the ${summary.introducedCount} introduced diagnostic(s) above as caused by this ${summary.displayPath} edit/write. Repair them, run a focused read/diagnostic command, or explain why a safe repair is not possible. Stop after ${summary.repair.maxAttempts} unchanged attempt(s).`,
		);
	}

	return lines.join("\n");
}

export function getDiagnosticDeltaFromToolResult(
	message: ToolResultMessage,
): DiagnosticDeltaToolSummary | undefined {
	const details = message.details;
	if (!details || typeof details !== "object") {
		return undefined;
	}
	const diagnosticDelta = (details as DiagnosticDeltaDetails).diagnosticDelta;
	if (diagnosticDelta?.kind !== "diagnostic_delta") {
		return undefined;
	}
	return diagnosticDelta;
}

export function buildDiagnosticRepairFollowUpMessage({
	summary,
	toolName,
	toolCallId,
	attempt,
}: {
	summary: DiagnosticDeltaToolSummary;
	toolName: string;
	toolCallId: string;
	attempt: number;
}): AppMessage {
	const diagnosticLines = summary.introducedDiagnostics
		.slice(0, 5)
		.map(
			(diagnostic) =>
				`- ${diagnostic.severityLabel} ${summary.displayPath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
		);
	const moreCount =
		summary.introducedDiagnostics.length - diagnosticLines.length;
	if (moreCount > 0) {
		diagnosticLines.push(
			`- ...and ${moreCount} more introduced diagnostic(s).`,
		);
	}

	return {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`The ${toolName} tool call ${toolCallId} introduced ${summary.introducedCount} new diagnostic(s) in ${summary.displayPath}.`,
					`Automatic diagnostic repair attempt ${attempt}/${summary.repair.maxAttempts}.`,
					"Decide the smallest safe next step: repair the introduced diagnostics, run a focused read/diagnostic command, explain why a repair is unsafe, or stop if the user's request is already complete.",
					"Do not chase diagnostics that existed before this tool call, and do not repeat an unchanged repair attempt.",
					diagnosticLines.join("\n"),
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
		timestamp: Date.now(),
	};
}

export function hasDiagnosticRepairOptOut(messages: AppMessage[]): boolean {
	const lastUser = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	if (!lastUser) {
		return false;
	}
	const text = messageText(lastUser).toLowerCase();
	return /\b(do not|don't|dont|no)\s+(continue|repair|fix|self[- ]?repair|auto[- ]?repair)\b/.test(
		text,
	);
}

function structureDiagnostic(
	diagnostic: LspDiagnostic,
): StructuredDiagnosticDeltaDiagnostic {
	return {
		message: diagnostic.message,
		severity: diagnostic.severity,
		severityLabel: severityLabel(diagnostic.severity),
		source: diagnostic.source,
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		range: diagnostic.range,
	};
}

function severityLabel(
	severity: LspDiagnostic["severity"],
): StructuredDiagnosticDeltaDiagnostic["severityLabel"] {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "information";
		case 4:
			return "hint";
		default:
			return "unknown";
	}
}

function fingerprintDiagnostics(diagnostics: LspDiagnostic[]): string {
	if (diagnostics.length === 0) {
		return "none";
	}
	const payload = diagnostics
		.map((diagnostic) =>
			JSON.stringify({
				severity: diagnostic.severity ?? null,
				source: diagnostic.source ?? null,
				message: diagnostic.message,
				range: diagnostic.range,
			}),
		)
		.sort()
		.join("\n");
	return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function messageText(message: AppMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}
