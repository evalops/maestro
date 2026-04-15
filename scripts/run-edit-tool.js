#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const tmpFile = join(projectRoot, "evals", "edit-test.txt");
writeFileSync(tmpFile, "Hello world\n");

const { editTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "edit.js")).href,
);

const result = await editTool.execute("eval-edit", {
	path: tmpFile,
	oldText: "world",
	newText: "evals",
});

const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("Edit tool returned no text output");
	process.exit(1);
}
console.log(text.text.trim());

unlinkSync(tmpFile);
