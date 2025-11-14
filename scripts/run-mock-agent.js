#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const target = process.argv[2] ?? "README.md";
const targetPath = join(projectRoot, target);
if (!existsSync(targetPath)) {
	console.error(`Target file not found: ${target}`);
	process.exit(1);
}

const agentModule = await import(
	pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
);
const toolsModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "read.js")).href,
);
const helpersModule = await import(
	pathToFileURL(join(projectRoot, "dist", "testing", "mock-agent.js")).href,
);

const { Agent } = agentModule;
const { readTool } = toolsModule;
const { MockToolTransport } = helpersModule;

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

let readSummary = "";
const transport = new MockToolTransport(
	[
		{
			name: "read",
			args: { path: targetPath },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readSummary =
					firstText?.text?.split("\n").find((line) => line.trim()) ?? "";
			},
		},
	],
	() => `Read ${targetPath}: ${readSummary.trim()}`,
);

const agent = new Agent({
	transport,
	initialState: { model: mockModel, tools: [] },
});
agent.setModel(mockModel);
agent.setTools([readTool]);

await agent.prompt(`Read file ${targetPath}`);

const lastAssistant = [...agent.state.messages]
	.reverse()
	.find((msg) => msg.role === "assistant");

if (!lastAssistant) {
	console.error("No assistant response recorded.");
	process.exit(1);
}

const textContent = lastAssistant.content.find((c) => c.type === "text");
if (!textContent) {
	console.error("Assistant response missing text content.");
	process.exit(1);
}

console.log(textContent.text.trim());
