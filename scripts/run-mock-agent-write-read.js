#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlinkSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-agent-flow.txt");

const agentModule = await import(
	pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
);
const readModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "read.js")).href,
);
const writeModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "write.js")).href,
);
const helpersModule = await import(
	pathToFileURL(join(projectRoot, "dist", "testing", "mock-agent.js")).href,
);

const { Agent } = agentModule;
const { readTool } = readModule;
const { writeTool } = writeModule;
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
		{ name: "write", args: { path: targetFile, content: "Hello evals" } },
		{
			name: "read",
			args: { path: targetFile },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readSummary =
					firstText?.text?.split("\n").find((line) => line.trim()) ?? "";
			},
		},
	],
	() => `Wrote and read ${targetFile}: ${readSummary.trim()}`,
);

const agent = new Agent({
	transport,
	initialState: { model: mockModel, tools: [] },
});
agent.setModel(mockModel);
agent.setTools([writeTool, readTool]);

await agent.prompt(`Write and read ${targetFile}`);

const finalAssistant = [...agent.state.messages]
	.reverse()
	.find((msg) => msg.role === "assistant");

if (!finalAssistant) {
	console.error("No assistant response recorded.");
	process.exit(1);
}

const textContent = finalAssistant.content.find((c) => c.type === "text");
if (!textContent) {
	console.error("Assistant response missing text content.");
	process.exit(1);
}

console.log(textContent.text.trim());

if (existsSync(targetFile)) {
	unlinkSync(targetFile);
}
