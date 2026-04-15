import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { printEvalSuiteReport, type EvalSuiteResult } from "./shared";

export interface OpenRouterLiveEvalCase {
	name: string;
	modelId: string;
	sentinel: string;
	prompt: string;
}

interface OpenRouterAgentInstance {
	prompt(prompt: string): Promise<void>;
	state: {
		messages: unknown[];
	};
}

interface OpenRouterRuntime {
	Agent: new (options: {
		transport: unknown;
		initialState: {
			model: unknown;
			tools: [];
		};
	}) => OpenRouterAgentInstance;
	transport: unknown;
	getModel(provider: "openrouter", modelId: string): unknown;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..");

export const openRouterLiveCases: OpenRouterLiveEvalCase[] = [
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

export function normalizeAssistantText(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

export function matchesExactSentinelResponse(
	assistantText: string,
	sentinel: string,
): boolean {
	return normalizeAssistantText(assistantText) === sentinel;
}

export async function runOpenRouterLiveSmokeEvalSuite(
	testCases: OpenRouterLiveEvalCase[] = openRouterLiveCases,
	apiKey = process.env.OPENROUTER_API_KEY?.trim(),
): Promise<{
	results: Array<EvalSuiteResult<{ name: string }, string>>;
	summary: ReturnType<typeof printEvalSuiteReport>;
}> {
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY is required for the live smoke eval.");
	}

	const runtime = await loadOpenRouterRuntime(apiKey);
	const results: Array<EvalSuiteResult<{ name: string }, string>> = [];

	for (const testCase of testCases) {
		results.push(await runLiveCase(testCase, runtime));
	}

	return {
		results,
		summary: printEvalSuiteReport("openrouter-live-smoke", results),
	};
}

async function runLiveCase(
	testCase: OpenRouterLiveEvalCase,
	runtime: OpenRouterRuntime,
): Promise<EvalSuiteResult<{ name: string }, string>> {
	try {
		const model = runtime.getModel("openrouter", testCase.modelId);
		if (!model) {
			throw new Error(`OpenRouter model not found: ${testCase.modelId}`);
		}

		const agent = new runtime.Agent({
			transport: runtime.transport,
			initialState: {
				model,
				tools: [],
			},
		});

		await agent.prompt(testCase.prompt);
		const assistantText = normalizeAssistantText(
			extractAssistantText(agent.state.messages),
		);
		const pass = matchesExactSentinelResponse(assistantText, testCase.sentinel);

		return {
			testCase: { name: testCase.name },
			actual: assistantText,
			pass,
			mismatch: pass
				? null
				: `expected exact response ${JSON.stringify(testCase.sentinel)} but received ${JSON.stringify(assistantText)}`,
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

async function loadOpenRouterRuntime(apiKey: string): Promise<OpenRouterRuntime> {
	const { Agent } = await import(
		pathToFileURL(join(projectRoot, "dist/agent/agent.js")).href,
	);
	const { ProviderTransport } = await import(
		pathToFileURL(join(projectRoot, "dist/agent/transport.js")).href,
	);
	const { getModel } = await import(
		pathToFileURL(join(projectRoot, "dist/models/builtin.js")).href,
	);

	const transport = new ProviderTransport({
		getApiKey(provider) {
			return provider === "openrouter" ? apiKey : undefined;
		},
	});

	return {
		Agent,
		transport,
		getModel,
	};
}

export function extractAssistantText(messages: unknown[]): string {
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

async function main(): Promise<void> {
	const { summary } = await runOpenRouterLiveSmokeEvalSuite();
	if (summary.failed > 0) {
		process.exitCode = 1;
	}
}

function isExecutedDirectly(moduleUrl: string): boolean {
	const entryPoint = process.argv[1];
	return Boolean(entryPoint) && moduleUrl === pathToFileURL(resolve(entryPoint)).href;
}

if (isExecutedDirectly(import.meta.url)) {
	await main();
}
