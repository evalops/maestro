#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMockAgentFlow } from "./mock-agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-edit-flow.txt");

let readContent = "";

await runMockAgentFlow({
	steps: [
		{ name: "write", args: { path: targetFile, content: "Original" } },
		{ name: "edit", args: { path: targetFile, oldText: "Original", newText: "Updated" } },
		{
			name: "read",
			args: { path: targetFile },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readContent = firstText?.text ?? "";
			},
		},
	],
	buildSummary: () => `Edited ${targetFile}: ${readContent.includes("Updated") ? "ok" : readContent.trim()}`,
	targetPath: targetFile,
	tools: ["write", "edit", "read"],
	cleanup: true,
	prompt: `Edit ${targetFile}`,
});

if (!readContent.includes("Updated")) {
	throw new Error("mock edit/read flow did not read the expected updated file content");
}
