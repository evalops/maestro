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

	if (typeof expectedNode !== "string" || expectedNode.length === 0) {
		fail(`Invalid tool-versions.json: missing "node"`);
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

	if (process.exitCode) {
		return;
	}
	console.log("[verify-tool-versions] ok");
}

main();
