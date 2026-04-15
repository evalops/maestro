#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const targetFile = join(projectRoot, "README.md");
const original = readFileSync(targetFile, "utf-8");
writeFileSync(targetFile, `${original}\nTEMP-CHANGE\n`);

try {
	const { diffTool } = await import(
		pathToFileURL(join(projectRoot, "dist", "tools", "diff.js")).href,
	);

	const result = await diffTool.execute("eval-diff", {
		paths: [targetFile],
	});

	const text = result.content.find((item) => item.type === "text");
	if (!text) {
		console.error("Diff tool returned no text output");
		process.exit(1);
	}
	console.log(text.text.split("\n")[0]);
} finally {
	writeFileSync(targetFile, original);
}
