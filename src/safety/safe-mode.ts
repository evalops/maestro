import { exec } from "node:child_process";
import type { ExecException } from "node:child_process";
import { promisify } from "node:util";
import type { LspDiagnostic } from "../lsp/index.js";

const execAsync = promisify(exec);

const SAFE_MODE_ENV = "COMPOSER_SAFE_MODE";
const VALIDATORS_ENV = "COMPOSER_SAFE_VALIDATORS";
const REQUIRE_PLAN_ENV = "COMPOSER_SAFE_REQUIRE_PLAN";

type SafeModeState = {
	enabled: boolean;
	requirePlan: boolean;
	validators: string[];
	lspBlockingSeverity: number;
	planSatisfied: boolean;
};

export type ValidatorRunResult = {
	command: string;
	stdout: string;
	stderr: string;
};

export class ValidatorError extends Error {
	constructor(
		public readonly result: ValidatorRunResult,
		public readonly originalError?: Error,
	) {
		super(
			`Validator failed (${result.command}). See validator output for details.`,
		);
		this.name = "ValidatorError";
	}
}

const state: SafeModeState = {
	enabled: false,
	requirePlan: false,
	validators: [],
	lspBlockingSeverity: 1,
	planSatisfied: false,
};

let configured = false;

export function configureSafeMode(force = false): void {
	if (configured && !force) {
		return;
	}
	configured = true;
	state.enabled = process.env[SAFE_MODE_ENV] === "1";
	state.requirePlan = false;
	state.validators = [];
	state.lspBlockingSeverity = process.env.COMPOSER_SAFE_LSP_SEVERITY
		? Number(process.env.COMPOSER_SAFE_LSP_SEVERITY)
		: 1;
	state.planSatisfied = false;
	if (!state.enabled) {
		return;
	}
	state.requirePlan = process.env[REQUIRE_PLAN_ENV] !== "0";
	const validatorsRaw = process.env[VALIDATORS_ENV] ?? "";
	state.validators = validatorsRaw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

configureSafeMode();

export function setPlanSatisfied(value: boolean): void {
	state.planSatisfied = value;
}

export function requirePlanCheck(toolName: string): void {
	if (!state.enabled || !state.requirePlan) {
		return;
	}
	if (state.planSatisfied) {
		return;
	}
	throw new Error(
		`Safe mode requires a plan before executing ${toolName}. Create or update a todo checklist first.`,
	);
}

type ExecError = ExecException & { stdout?: string; stderr?: string };

type BlockingDiagnostic = {
	file: string;
	message: string;
	range?: LspDiagnostic["range"];
	severity?: number;
};

function isExecError(error: unknown): error is ExecError {
	return (
		typeof error === "object" &&
		error !== null &&
		"stdout" in error &&
		"stderr" in error
	);
}

export async function runValidatorsOnSuccess(
	paths: string[],
	lspDiagnostics?: Record<string, LspDiagnostic[]>,
): Promise<ValidatorRunResult[]> {
	if (!state.enabled) {
		return [];
	}
	const summaries: ValidatorRunResult[] = [];
	if (lspDiagnostics) {
		const blocking = findBlockingDiagnostics(lspDiagnostics);
		if (blocking.length > 0) {
			const commandLabel = "lsp-diagnostics";
			throw new ValidatorError({
				command: commandLabel,
				stdout: blocking
					.map(
						(entry) =>
							`${entry.file}:${entry.range?.start.line ?? 0}:${entry.range?.start.character ?? 0} ${entry.message}`,
					)
					.join("\n"),
				stderr: "",
			});
		}
	}
	if (state.validators.length === 0) {
		return summaries;
	}
	const env = {
		...process.env,
		COMPOSER_SAFE_CHANGED_PATHS: paths.join("::"),
	};
	for (const command of state.validators) {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: process.cwd(),
				env,
			});
			summaries.push({ command, stdout, stderr });
		} catch (error) {
			if (isExecError(error)) {
				const summary: ValidatorRunResult = {
					command,
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? "",
				};
				throw new ValidatorError(summary, error);
			}
			throw error;
		}
	}
	return summaries;
}

function findBlockingDiagnostics(
	diagnostics: Record<string, LspDiagnostic[]>,
): BlockingDiagnostic[] {
	const blocking: BlockingDiagnostic[] = [];
	for (const [file, entries] of Object.entries(diagnostics)) {
		for (const diag of entries) {
			const severity = diag.severity ?? Number.POSITIVE_INFINITY;
			if (severity <= state.lspBlockingSeverity) {
				blocking.push({
					file,
					message: diag.message,
					range: diag.range,
					severity: diag.severity,
				});
			}
		}
	}
	return blocking;
}

export function resetSafeModeForTests(): void {
	configured = false;
	state.enabled = false;
	state.requirePlan = false;
	state.validators = [];
	state.planSatisfied = false;
}

export function isSafeModeEnabled(): boolean {
	return state.enabled;
}
