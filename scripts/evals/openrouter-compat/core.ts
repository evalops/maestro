import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterResponsesApiTools } from "../../../src/agent/providers/openai-shared.js";
import {
	resolveOpenAICompatForTest,
	resolveOpenAIUrlForTest,
} from "../../../src/agent/providers/openai.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type OpenRouterCompatEvalKind = "compat" | "url" | "responsesTools";

export interface OpenRouterCompatEvalCase {
	name: string;
	kind: OpenRouterCompatEvalKind;
	input: Record<string, unknown>;
	expected: unknown;
}

export type OpenRouterCompatEvalResult = EvalSuiteResult<
	OpenRouterCompatEvalCase,
	unknown
>;

const DEFAULT_CASES_PATH = "evals/openrouter/compat-cases.json";

export function getOpenRouterCompatEvalCasesPath(): string {
	return process.env.OPENROUTER_COMPAT_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadOpenRouterCompatEvalCases(
	casesPath = getOpenRouterCompatEvalCasesPath(),
): OpenRouterCompatEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(
		readFileSync(fixturePath, "utf8"),
	) as OpenRouterCompatEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export function runOpenRouterCompatEvalCase(
	testCase: OpenRouterCompatEvalCase,
): OpenRouterCompatEvalResult {
	const actual = evaluateOpenRouterCompatCase(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export function runOpenRouterCompatEvalSuite(
	cases: OpenRouterCompatEvalCase[],
): OpenRouterCompatEvalResult[] {
	return cases.map((testCase) => runOpenRouterCompatEvalCase(testCase));
}

export function summarizeOpenRouterCompatEvalResults(
	results: OpenRouterCompatEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

function evaluateOpenRouterCompatCase(
	testCase: OpenRouterCompatEvalCase,
): unknown {
	const input = testCase.input;

	switch (testCase.kind) {
		case "compat":
			return resolveOpenAICompatForTest(
				input.model as Parameters<typeof resolveOpenAICompatForTest>[0],
			);

		case "url":
			return resolveOpenAIUrlForTest(
				(input.baseUrl as string) ?? "",
				(input.api as "openai-responses" | "openai-completions") ??
					"openai-completions",
			);

		case "responsesTools": {
			const toolNames = filterResponsesApiTools(
				(input.tools as Array<{
					name: string;
					description: string;
					parameters: unknown;
				}>) ?? [],
			).map((tool) => tool.name);

			return {
				toolNames,
			};
		}

		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported OpenRouter compat eval kind: ${neverKind}`);
		}
	}
}
