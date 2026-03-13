import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { printEvalSuiteReport, type EvalSuiteResult } from "./shared";

interface OpenRouterLiveEvalCase {
	name: string;
	modelId: string;
	sentinel: string;
	prompt: string;
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();

if (!apiKey) {
	console.error("OPENROUTER_API_KEY is required for the live smoke eval.");
	process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..");

const { Agent } = await import(
	pathToFileURL(join(projectRoot, "dist/agent/agent.js")).href,
);
const { ProviderTransport } = await import(
	pathToFileURL(join(projectRoot, "dist/agent/transport.js")).href,
);
const { getModel } = await import(
	pathToFileURL(join(projectRoot, "dist/models/builtin.js")).href,
);

const liveCases: OpenRouterLiveEvalCase[] = [
	{
		name: "OpenRouter chat completions model returns the expected sentinel",
		modelId:
			process.env.OPENROUTER_EVAL_COMPLETIONS_MODEL?.trim() ||
			"openai/gpt-4o-mini",
		sentinel: "COMPOSER_OPENROUTER_COMPLETIONS_OK",
		prompt:
			"Reply with exactly COMPOSER_OPENROUTER_COMPLETIONS_OK and nothing else.",
	},
	{
		name: "OpenRouter responses model returns the expected sentinel",
		modelId:
			process.env.OPENROUTER_EVAL_RESPONSES_MODEL?.trim() || "openai/o4-mini",
		sentinel: "COMPOSER_OPENROUTER_RESPONSES_OK",
		prompt:
			"Reply with exactly COMPOSER_OPENROUTER_RESPONSES_OK and nothing else.",
	},
];

const transport = new ProviderTransport({
	getApiKey(provider) {
		return provider === "openrouter" ? apiKey : undefined;
	},
});

const results: Array<EvalSuiteResult<{ name: string }, string>> = [];

for (const testCase of liveCases) {
	results.push(await runLiveCase(testCase));
}

const summary = printEvalSuiteReport("openrouter-live-smoke", results);

if (summary.failed > 0) {
	process.exitCode = 1;
}

async function runLiveCase(
	testCase: OpenRouterLiveEvalCase,
): Promise<EvalSuiteResult<{ name: string }, string>> {
	try {
		const model = getModel("openrouter", testCase.modelId);
		if (!model) {
			throw new Error(`OpenRouter model not found: ${testCase.modelId}`);
		}

		const agent = new Agent({
			transport,
			initialState: {
				model,
				tools: [],
			},
		});

		await agent.prompt(testCase.prompt);
		const assistantText = extractAssistantText(agent.state.messages);
		const pass = assistantText.includes(testCase.sentinel);

		return {
			testCase: { name: testCase.name },
			actual: assistantText,
			pass,
			mismatch: pass
				? null
				: `expected the response to include ${testCase.sentinel} but received ${JSON.stringify(assistantText)}`,
		};
	} catch (error) {
		return {
			testCase: { name: testCase.name },
			actual: "",
			pass: false,
			mismatch:
				error instanceof Error ? error.message : String(error ?? "Unknown error"),
		};
	}
}

function extractAssistantText(messages: unknown[]): string {
	const assistantMessage = [...messages].reverse().find((message) => {
		return (
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "assistant"
		);
	}) as { content?: Array<{ type?: string; text?: string }> } | undefined;

	if (!assistantMessage) {
		throw new Error("No assistant message was recorded.");
	}

	return (assistantMessage.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
