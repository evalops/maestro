import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEvalResult, printEvalSuiteReport } from "./shared";

interface OpenRouterCompatEvalCase {
	name: string;
	kind: "compat" | "url" | "responsesTools";
	input: Record<string, unknown>;
	expected: unknown;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..");
const casesPath = resolve(projectRoot, "evals/openrouter/compat-cases.json");

const { resolveOpenAICompatForTest, resolveOpenAIUrlForTest } = await import(
	pathToFileURL(join(projectRoot, "dist/agent/providers/openai.js")).href,
);
const { filterResponsesApiTools } = await import(
	pathToFileURL(join(projectRoot, "dist/agent/providers/openai-shared.js")).href,
);

const cases = JSON.parse(
	readFileSync(casesPath, "utf8"),
) as OpenRouterCompatEvalCase[];

const results = cases.map((testCase) => {
	let actual: unknown;

	switch (testCase.kind) {
		case "compat":
			actual = resolveOpenAICompatForTest(
				testCase.input.model as Parameters<typeof resolveOpenAICompatForTest>[0],
			);
			break;

		case "url":
			actual = resolveOpenAIUrlForTest(
				testCase.input.baseUrl as string,
				testCase.input.api as "openai-responses" | "openai-completions",
			);
			break;

		case "responsesTools":
			actual = {
				toolNames: filterResponsesApiTools(
					testCase.input.tools as Array<{
						name: string;
						description: string;
						parameters: unknown;
					}>,
				).map(
					(tool: { name: string }) => tool.name,
				),
			};
			break;

		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported OpenRouter compat eval kind: ${neverKind}`);
		}
	}

	return createEvalResult(testCase, actual, testCase.expected);
});

const summary = printEvalSuiteReport("openrouter-compat-evals", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}
