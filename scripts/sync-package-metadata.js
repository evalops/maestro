#!/usr/bin/env node
// @ts-check

import { readFileSync, writeFileSync } from "node:fs";
import { getGlobalInstallCommand, getPackageMetadata } from "./package-metadata.js";

const checkOnly = process.argv.includes("--check");
const { name, cliCommand } = getPackageMetadata();
const npmInstall = getGlobalInstallCommand("npm");
const bunInstall = getGlobalInstallCommand("bun");

/**
 * @param {string} content
 * @param {RegExp} pattern
 * @param {string} replacement
 * @param {string} description
 */
function replaceRequired(content, pattern, replacement, description) {
	if (!pattern.test(content)) {
		throw new Error(`Could not find ${description}`);
	}
	return content.replace(pattern, replacement);
}

const targets = [
	{
		path: "README.md",
		transform(content) {
			let next = replaceRequired(
				content,
				/^bun install -g\s+.+$/m,
				bunInstall,
				"README Bun install command",
			);
			next = replaceRequired(
				next,
				/^npm install -g\s+.+$/m,
				npmInstall,
				"README npm install command",
			);
			return next;
		},
	},
	{
		path: "packages/jetbrains-plugin/README.md",
		transform(content) {
			let next = replaceRequired(
				content,
				/^npm install -g\s+.+$/m,
				npmInstall,
				"JetBrains README npm install command",
			);
			next = replaceRequired(
				next,
				/^(?:composer|maestro) web$/m,
				`${cliCommand} web`,
				"JetBrains README web command",
			);
			return next;
		},
	},
	{
		path: "packages/jetbrains-plugin/src/main/resources/META-INF/plugin.xml",
		transform(content) {
			let next = replaceRequired(
				content,
				/<code>npm install -g [^<]+<\/code>/,
				`<code>${npmInstall}</code>`,
				"JetBrains plugin XML install command",
			);
			next = replaceRequired(
				next,
				/<code>(?:composer|maestro) web<\/code>/,
				`<code>${cliCommand} web</code>`,
				"JetBrains plugin XML web command",
			);
			return next;
		},
	},
	{
		path: "src/agent/types.ts",
		transform(content) {
			return replaceRequired(
				content,
				/declare module "[^"]+" \{/,
				`declare module "${name}" {`,
				"CustomAgentMessages module augmentation example",
			);
		},
	},
];

const changedFiles = [];

for (const target of targets) {
	const current = readFileSync(target.path, "utf-8");
	const next = target.transform(current);

	if (next === current) {
		continue;
	}

	changedFiles.push(target.path);
	if (!checkOnly) {
		writeFileSync(target.path, next);
	}
}

if (checkOnly) {
	if (changedFiles.length > 0) {
		console.error("Package metadata is out of sync:");
		for (const file of changedFiles) {
			console.error(`- ${file}`);
		}
		process.exit(1);
	}
	console.log("Package metadata is in sync.");
} else if (changedFiles.length > 0) {
	console.log(`Synced package metadata in ${changedFiles.length} files.`);
} else {
	console.log("Package metadata already in sync.");
}
