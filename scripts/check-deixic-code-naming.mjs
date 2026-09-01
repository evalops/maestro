#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_TEXT = new Map([
	["README.md", ["# Deixic Code", "deixic-code --version", "@evalops/maestro"]],
	["docs/DEIXIC_CODE_MIGRATION.md", ["## Compatibility matrix", "@evalops/deixic-code", "`maestro`"]],
	["packages/maestro-rs/src/main.rs", ["Deixic Code\\n\\nUsage:", "deixic-code setup", "maestro remains available as an alias"]],
	["packages/tui-rs/src/components/deixic_logo.rs", ["shimmer_spans(\"Deixic Code\")"]],
	["packages/web/dist/index.html", ["<title>Deixic Code - AI Coding Assistant</title>", "Loading Deixic Code..."]],
	["packages/jetbrains-plugin/src/main/resources/META-INF/plugin.xml", ["<name>Deixic Code</name>", "id=\"Maestro\"", "id=\"Maestro Notifications\""]],
	["scripts/install.sh", ["$install_dir/deixic-code", "$install_dir/maestro", "Installed Deixic Code"]],
	["scripts/materialize-native-package.mjs", ["resolve(\"bin\", \"deixic-code\")", "exec \"$bin_dir/maestro\" \"$@\""]],
]);

const FORBIDDEN_DISPLAY_TEXT = new Map([
	["packages/web/dist/index.html", ["<title>Maestro", "Loading Maestro"]],
	["packages/maestro-rs/src/main.rs", ["const HELP: &str = \"Maestro", "Usage:\\n  maestro setup"]],
	["packages/tui-rs/src/components/deixic_logo.rs", ["shimmer_spans(\"Maestro\")"]],
	["packages/jetbrains-plugin/src/main/resources/META-INF/plugin.xml", ["<name>Maestro</name>", "text=\"Focus Maestro\""]],
]);

function contentAt(root, path, overrides) {
	return overrides.get(path) ?? readFileSync(resolve(root, path), "utf8");
}

export function findDeixicCodeNamingProblems(
	root = new URL("..", import.meta.url).pathname,
	overrides = new Map(),
) {
	const problems = [];
	const packageJson = JSON.parse(contentAt(root, "package.json", overrides));
	const binCommands = Object.keys(packageJson.bin ?? {});

	const canonicalPackageName = packageJson.maestro?.canonicalPackageName;
	const packageAliases = packageJson.maestro?.packageAliases;
	if (
		packageJson.name !== canonicalPackageName &&
		!packageAliases?.includes(packageJson.name)
	) {
		problems.push(
			"package.json name must be the canonical package or a declared package alias",
		);
	}
	if (canonicalPackageName !== "@evalops/deixic-code") {
		problems.push("package.json canonical package must be @evalops/deixic-code");
	}
	if (!packageAliases?.includes("@evalops/maestro")) {
		problems.push("package.json must retain @evalops/maestro as a package alias");
	}
	if (binCommands[0] !== "deixic-code" || packageJson.bin?.maestro !== "bin/maestro") {
		problems.push("package.json must declare deixic-code first and retain the maestro binary alias");
	}

	for (const [path, snippets] of REQUIRED_TEXT) {
		const content = contentAt(root, path, overrides);
		for (const snippet of snippets) {
			if (!content.includes(snippet)) problems.push(`${path} is missing ${JSON.stringify(snippet)}`);
		}
	}
	for (const [path, snippets] of FORBIDDEN_DISPLAY_TEXT) {
		const content = contentAt(root, path, overrides);
		for (const snippet of snippets) {
			if (content.includes(snippet)) problems.push(`${path} contains stale display text ${JSON.stringify(snippet)}`);
		}
	}

	return problems;
}

export function main() {
	const problems = findDeixicCodeNamingProblems();
	if (problems.length > 0) {
		console.error("Deixic Code naming check failed:");
		for (const problem of problems) console.error(`- ${problem}`);
		return 1;
	}
	console.log("Deixic Code naming and compatibility check passed.");
	return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	process.exitCode = main();
}
