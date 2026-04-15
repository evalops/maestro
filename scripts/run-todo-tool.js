#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const { todoTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "todo.js")).href,
);

const result = await todoTool.execute("eval-todo", {
	goal: "Eval todo",
	items: [
		{ content: "write script" },
		{ content: "add eval", priority: "high" },
	],
});

const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("Todo tool returned no text output");
	process.exit(1);
}
console.log(text.text.trim());
