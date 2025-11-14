#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const tmpFile = join(projectRoot, "evals", "diff-test.txt");
writeFileSync(tmpFile, "a\n");
execSync(`cd ${projectRoot} && git add evals/diff-test.txt`);
writeFileSync(tmpFile, "a\nchanged\n");

const { diffTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "diff.js")).href,
);

const result = await diffTool.execute("eval-diff", {
	paths: [tmpFile],
});

const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("Diff tool returned no text output");
	process.exit(1);
}
console.log(text.text.split("\n")[0]);

if (existsSync(tmpFile)) {
	unlinkSync(tmpFile);
	execSync(`cd ${projectRoot} && git checkout -- evals/diff-test.txt`);
}
