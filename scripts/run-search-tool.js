#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const target = process.argv[2] ?? "README.md";
const pattern = process.argv[3] ?? "Composer";

const { searchTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "search.js")).href,
);

const result = await searchTool.execute("eval-search", {
	pattern,
	paths: [join(projectRoot, target)],
	maxResults: 5,
});

const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("Search tool returned no text content");
	process.exit(1);
}
const match = text.text.split("\n").find((line) => line.includes(pattern));
if (!match) {
	console.error("Search output did not contain pattern");
	process.exit(1);
}
console.log(match.trim());
