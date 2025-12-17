#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
	console.error(`[verify-tool-versions] ${message}`);
	process.exitCode = 1;
}

function readText(filePath) {
	return fs.readFileSync(filePath, "utf8");
}

function readTrimmedLine(filePath) {
	return readText(filePath).trim();
}

function getRepoRoot() {
	// This script lives in scripts/, so repo root is one directory up.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..");
}

function main() {
	const repoRoot = getRepoRoot();
	const versionsPath = path.join(repoRoot, "tool-versions.json");
	const versions = JSON.parse(readText(versionsPath));

	const expectedNode = versions.node;
	const expectedBun = versions.bun;
	const expectedSemgrep = versions.semgrep;

	if (typeof expectedNode !== "string" || expectedNode.length === 0) {
		fail(`Invalid tool-versions.json: missing "node"`);
		return;
	}
	if (typeof expectedBun !== "string" || expectedBun.length === 0) {
		fail(`Invalid tool-versions.json: missing "bun"`);
		return;
	}
	if (typeof expectedSemgrep !== "string" || expectedSemgrep.length === 0) {
		fail(`Invalid tool-versions.json: missing "semgrep"`);
		return;
	}

	const nodeVersionFiles = [".node-version", ".nvmrc"];
	for (const rel of nodeVersionFiles) {
		const filePath = path.join(repoRoot, rel);
		const actual = readTrimmedLine(filePath);
		if (actual !== expectedNode) {
			fail(`${rel} is "${actual}" but tool-versions.json node is "${expectedNode}"`);
		}
	}

	const setupActionPath = path.join(repoRoot, ".github/actions/setup-bun-nx/action.yml");
	const setupAction = readText(setupActionPath);
	const bunVersionMatch = setupAction.match(
		/^[ \t]*bun-version:\s*$[\s\S]*?^[ \t]*default:\s*"([^"]+)"\s*$/m,
	);
	if (!bunVersionMatch) {
		fail(`Could not find a default bun-version in ${path.relative(repoRoot, setupActionPath)}`);
	} else {
		const actualBun = bunVersionMatch[1];
		if (actualBun !== expectedBun) {
			fail(
				`setup-bun-nx bun-version default is "${actualBun}" but tool-versions.json bun is "${expectedBun}"`,
			);
		}
	}

	const evalsWorkflowPath = path.join(repoRoot, ".github/workflows/evals.yml");
	const evalsWorkflow = readText(evalsWorkflowPath);
	if (!evalsWorkflow.includes(`semgrep==${expectedSemgrep}`)) {
		fail(
			`Expected evals workflow to install semgrep==${expectedSemgrep} (see ${path.relative(repoRoot, evalsWorkflowPath)})`,
		);
	}

	if (process.exitCode) {
		return;
	}
	console.log("[verify-tool-versions] ok");
}

main();
