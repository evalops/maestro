import { basename } from "node:path";
import {
	type SkillLintIssue,
	type SkillLintResult,
	hasSkillLintErrors,
	lintSkillPaths,
} from "./linter.js";

type SkillEvalOptions = NonNullable<Parameters<typeof lintSkillPaths>[1]>;

export type SkillEvalOutcome = "pass" | "fail";
export type SkillEvalAssertionStatus = "pass" | "fail";

export interface SkillEvalCase {
	id?: string;
	path: string;
	expectedOutcome?: SkillEvalOutcome;
}

export interface SkillEvalAssertion {
	code: string;
	status: SkillEvalAssertionStatus;
	message: string;
}

export interface SkillEvalResult {
	id: string;
	path: string;
	expectedOutcome: SkillEvalOutcome;
	observedOutcome: SkillEvalOutcome;
	matchedExpectation: boolean;
	assertions: SkillEvalAssertion[];
	issues: SkillLintIssue[];
}

export interface SkillEvalReport {
	schemaVersion: "evalops.maestro.skill-package-eval.v1";
	summary: {
		total: number;
		passed: number;
		failed: number;
		score: number;
	};
	results: SkillEvalResult[];
}

function assertion(
	code: string,
	status: SkillEvalAssertionStatus,
	message: string,
): SkillEvalAssertion {
	return { code, status, message };
}

function hasIssue(result: SkillLintResult, codes: string[]): boolean {
	const wanted = new Set(codes);
	return result.issues.some((issue) => wanted.has(issue.code));
}

function hasIssuePrefix(result: SkillLintResult, prefixes: string[]): boolean {
	return result.issues.some((issue) =>
		prefixes.some((prefix) => issue.code.startsWith(prefix)),
	);
}

const LOADER_BLOCKING_ISSUE_CODES = [
	"missing_skill_md",
	"invalid_skill_md",
	"unexpected_field",
	"missing_name",
	"invalid_name",
	"name_too_long",
	"name_mismatch",
	"missing_description",
	"description_too_long",
	"invalid_compatibility",
	"invalid_string_list",
];

function assertionsFor(result: SkillLintResult): SkillEvalAssertion[] {
	const lintPasses = !hasSkillLintErrors([result]);
	const loadable = !hasIssue(result, LOADER_BLOCKING_ISSUE_CODES);
	const boundedMcp = !hasIssue(result, [
		"mcp_tools_unfiltered",
		"invalid_mcp_include_tools",
		"invalid_mcp_json",
		"invalid_mcp_server",
		"invalid_mcp_command",
		"invalid_mcp_args",
		"invalid_mcp_env",
	]);
	const toolboxRunnable = !hasIssuePrefix(result, ["toolbox_"]);
	const bodyWithinBudget = !hasIssue(result, ["skill_oversize"]);

	return [
		assertion(
			"lint_passes",
			lintPasses ? "pass" : "fail",
			lintPasses
				? "Package has no blocking lint issues."
				: "Package has blocking lint issues.",
		),
		assertion(
			"skill_md_loadable",
			loadable ? "pass" : "fail",
			loadable
				? "SKILL.md frontmatter is loadable."
				: "SKILL.md frontmatter is not loadable.",
		),
		assertion(
			"mcp_tools_bounded",
			boundedMcp ? "pass" : "fail",
			boundedMcp
				? "Bundled MCP servers are filtered and well-formed."
				: "Bundled MCP servers are missing bounded includeTools or are malformed.",
		),
		assertion(
			"toolbox_runnable",
			toolboxRunnable ? "pass" : "fail",
			toolboxRunnable
				? "Toolbox entries are executable for the target platform."
				: "Toolbox entries are not executable or fail describe checks.",
		),
		assertion(
			"progressive_disclosure_budget",
			bodyWithinBudget ? "pass" : "fail",
			bodyWithinBudget
				? "SKILL.md stays within progressive-disclosure budget."
				: "SKILL.md exceeds progressive-disclosure budget.",
		),
	];
}

function resultId(
	evalCase: SkillEvalCase,
	lintResult: SkillLintResult,
	resultCount: number,
): string {
	if (evalCase.id && resultCount === 1) return evalCase.id;
	if (evalCase.id) return `${evalCase.id}:${basename(lintResult.path)}`;
	return basename(lintResult.path);
}

export async function evaluateSkillPackages(
	cases: SkillEvalCase[],
	options: SkillEvalOptions = {},
): Promise<SkillEvalReport> {
	const results: SkillEvalResult[] = [];
	for (const evalCase of cases) {
		const lintResults = await lintSkillPaths([evalCase.path], options);
		for (const lintResult of lintResults) {
			const assertions = assertionsFor(lintResult);
			const observedOutcome = assertions.some((item) => item.status === "fail")
				? "fail"
				: "pass";
			const expectedOutcome = evalCase.expectedOutcome ?? "pass";
			results.push({
				id: resultId(evalCase, lintResult, lintResults.length),
				path: lintResult.path,
				expectedOutcome,
				observedOutcome,
				matchedExpectation: observedOutcome === expectedOutcome,
				assertions,
				issues: lintResult.issues,
			});
		}
	}

	const passed = results.filter((result) => result.matchedExpectation).length;
	const failed = results.length - passed;
	return {
		schemaVersion: "evalops.maestro.skill-package-eval.v1",
		summary: {
			total: results.length,
			passed,
			failed,
			score: results.length === 0 ? 1 : passed / results.length,
		},
		results,
	};
}

export function hasSkillEvalFailures(report: SkillEvalReport): boolean {
	return report.summary.failed > 0;
}

export function formatSkillEvalText(report: SkillEvalReport): string {
	const lines: string[] = [];
	for (const result of report.results) {
		const status = result.matchedExpectation ? "PASS" : "FAIL";
		lines.push(
			`${status} ${result.id} expected=${result.expectedOutcome} observed=${result.observedOutcome}`,
		);
		for (const assertionResult of result.assertions) {
			lines.push(
				`  ${assertionResult.status.toUpperCase()} ${assertionResult.code}: ${assertionResult.message}`,
			);
		}
		for (const issue of result.issues) {
			lines.push(
				`  ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`,
			);
		}
	}
	lines.push("");
	lines.push(
		`${report.summary.passed} passed, ${report.summary.failed} failed, score ${report.summary.score.toFixed(2)}`,
	);
	return lines.join("\n");
}
