#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMockAgentFlow } from "./mock-agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-edit-flow.txt");

let readSummary = "";

await runMockAgentFlow({
	steps: [
		{ name: "write", args: { path: targetFile, content: "Original" } },
		{ name: "edit", args: { path: targetFile, oldText: "Original", newText: "Updated" } },
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
	buildSummary: () => `Edited ${targetFile}: ${readSummary.trim()}`,
	targetPath: targetFile,
	tools: ["write", "edit", "read"],
	cleanup: true,
	prompt: `Edit ${targetFile}`,
});
