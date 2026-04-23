import { resolve as resolvePath } from "node:path";
import type { LspDiagnostic } from "./index.js";
import { collectDiagnostics } from "./index.js";
import { uriToPath } from "./utils.js";

export type DiagnosticBaseline = {
	file: string;
	diagnostics: LspDiagnostic[];
	captured: boolean;
	errorMessage?: string;
};

export type DiagnosticDeltaResult = {
	allDiagnostics: Record<string, LspDiagnostic[]>;
	fileDiagnostics: LspDiagnostic[];
	newDiagnostics: LspDiagnostic[];
	repairedDiagnostics: LspDiagnostic[];
	usedDelta: boolean;
	validatorDiagnostics: Record<string, LspDiagnostic[]>;
};

export async function captureDiagnosticBaseline(
	file: string,
): Promise<DiagnosticBaseline> {
	const normalizedFile = normalizeDiagnosticPath(file);

	try {
		const diagnostics = await collectDiagnostics();
		return {
			file: normalizedFile,
			diagnostics: diagnosticsForFile(diagnostics, normalizedFile),
			captured: true,
		};
	} catch (error) {
		return {
			file: normalizedFile,
			diagnostics: [],
			captured: false,
			errorMessage:
				error instanceof Error
					? error.message
					: "Unable to collect diagnostics",
		};
	}
}

export async function collectDiagnosticDelta(
	baseline: DiagnosticBaseline,
): Promise<DiagnosticDeltaResult> {
	const allDiagnostics = await collectDiagnostics();
	const fileDiagnostics = diagnosticsForFile(allDiagnostics, baseline.file);

	if (!baseline.captured) {
		return {
			allDiagnostics,
			fileDiagnostics,
			newDiagnostics: fileDiagnostics,
			repairedDiagnostics: [],
			usedDelta: false,
			validatorDiagnostics: allDiagnostics,
		};
	}

	const newDiagnostics = diffDiagnostics(baseline.diagnostics, fileDiagnostics);
	const repairedDiagnostics = diffDiagnostics(
		fileDiagnostics,
		baseline.diagnostics,
	);

	return {
		allDiagnostics,
		fileDiagnostics,
		newDiagnostics,
		repairedDiagnostics,
		usedDelta: true,
		validatorDiagnostics: {
			[baseline.file]: newDiagnostics,
		},
	};
}

export function diffDiagnostics(
	before: LspDiagnostic[],
	after: LspDiagnostic[],
): LspDiagnostic[] {
	const remainingBefore = new Map<string, number>();

	for (const diagnostic of before) {
		const key = diagnosticKey(diagnostic);
		remainingBefore.set(key, (remainingBefore.get(key) ?? 0) + 1);
	}

	const introduced: LspDiagnostic[] = [];
	for (const diagnostic of after) {
		const key = diagnosticKey(diagnostic);
		const count = remainingBefore.get(key) ?? 0;
		if (count > 0) {
			remainingBefore.set(key, count - 1);
			continue;
		}
		introduced.push(diagnostic);
	}

	return introduced;
}

export function diagnosticsForFile(
	diagnostics: Record<string, LspDiagnostic[]>,
	file: string,
): LspDiagnostic[] {
	const targetFile = normalizeDiagnosticPath(file);
	const direct = diagnostics[file] ?? diagnostics[targetFile];
	if (direct) return direct;

	for (const [diagnosticFile, entries] of Object.entries(diagnostics)) {
		if (normalizeDiagnosticPath(diagnosticFile) === targetFile) {
			return entries;
		}
	}

	return [];
}

function normalizeDiagnosticPath(file: string): string {
	return resolvePath(uriToPath(file));
}

function diagnosticKey(diagnostic: LspDiagnostic): string {
	return JSON.stringify({
		severity: diagnostic.severity ?? null,
		source: diagnostic.source ?? null,
		message: diagnostic.message,
		range: diagnostic.range,
	});
}
