#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const command = process.argv[2] ?? "echo bash tool";

const { bashTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "bash.js")).href,
);

const result = await bashTool.execute("eval-bash", { command });
const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("Bash tool returned no text output");
	process.exit(1);
}
console.log(text.text.trim());
