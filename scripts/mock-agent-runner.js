import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlinkSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

/**
 * @typedef {Object} MockFlowStep
 * @property {string} name
 * @property {Record<string, unknown>} args
 * @property {(result: any) => void} [onResult]
 */

/**
 * @typedef {Object} RunMockAgentOptions
 * @property {MockFlowStep[]} steps
 * @property {() => string} buildSummary
 * @property {string} targetPath
 * @property {string[]} tools
 * @property {boolean} [cleanup]
 * @property {string} [prompt]
 */

/**
 * @param {RunMockAgentOptions} options
 */
export async function runMockAgentFlow(options) {
	const {
		steps,
		buildSummary,
		targetPath,
		tools,
		cleanup = false,
		prompt,
	} = options;
	const agentModule = await import(
		pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
	);
	const helpersModule = await import(
		pathToFileURL(join(projectRoot, "dist", "testing", "mock-agent.js")).href,
	);

	const toolModules = await Promise.all(
		tools.map(async (toolName) => {
			const module = await import(
				pathToFileURL(join(projectRoot, "dist", "tools", `${toolName}.js`)).href,
			);
			const exportName = `${toolName}Tool`;
			const tool = module[exportName];
			if (!tool) {
				throw new Error(`Tool export "${exportName}" not found in ${toolName}.js`);
			}
			return { [toolName]: tool };
		}),
	);

	const { Agent } = agentModule;
	const { MockToolTransport } = helpersModule;
	const toolMap = toolModules.reduce((acc, mod) => Object.assign(acc, mod), {});
	const resolvedTools = tools.map((toolName) => {
		const tool = toolMap[toolName];
		if (!tool) {
			throw new Error(`Tool "${toolName}" not found`);
		}
		return tool;
	});

	const mockModel = {
		id: "mock-model",
		name: "Mock",
		provider: "mock",
		api: "openai-completions",
		baseUrl: "",
		reasoning: false,
		contextWindow: 8192,
		maxTokens: 2048,
		source: "builtin",
	};

	const transport = new MockToolTransport(
		steps,
		buildSummary,
	);

	const agent = new Agent({
		transport,
		initialState: { model: mockModel, tools: [] },
	});
	agent.setModel(mockModel);
	agent.setTools(resolvedTools);

	await agent.prompt(prompt ?? `Run mock flow for ${targetPath}`);

	const finalAssistant = [...agent.state.messages]
		.reverse()
		.find((msg) => msg.role === "assistant");

	if (!finalAssistant) {
		throw new Error("No assistant response recorded.");
	}

	const textContent = finalAssistant.content.find((c) => c.type === "text");
	if (!textContent) {
		throw new Error("Assistant response missing text content.");
	}

	console.log(textContent.text.trim());

	if (cleanup && existsSync(targetPath)) {
		unlinkSync(targetPath);
	}
}
