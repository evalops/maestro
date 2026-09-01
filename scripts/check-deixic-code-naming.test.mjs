import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { findDeixicCodeNamingProblems } from "./check-deixic-code-naming.mjs";

const root = new URL("..", import.meta.url).pathname;

test("the source tree keeps Deixic Code canonical and Maestro compatible", () => {
	assert.deepEqual(findDeixicCodeNamingProblems(root), []);
});

test("the generated canonical package keeps the compatibility contract", () => {
	const packagePath = new URL("../package.json", import.meta.url);
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	packageJson.name = packageJson.maestro.canonicalPackageName;
	packageJson.maestro.packageAliases = [
		packageJson.name,
		...packageJson.maestro.packageAliases,
	];
	assert.deepEqual(
		findDeixicCodeNamingProblems(
			root,
			new Map([["package.json", JSON.stringify(packageJson)]]),
		),
		[],
	);
});

test("the guard rejects a missing command alias", () => {
	const packagePath = new URL("../package.json", import.meta.url);
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	delete packageJson.bin.maestro;
	const problems = findDeixicCodeNamingProblems(
		root,
		new Map([["package.json", JSON.stringify(packageJson)]]),
	);
	assert(problems.some((problem) => problem.includes("maestro binary alias")));
});

test("the guard rejects stale customer-facing Maestro display copy", () => {
	const path = "packages/web/dist/index.html";
	const content = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
		.replace("<title>Deixic Code", "<title>Maestro");
	const problems = findDeixicCodeNamingProblems(root, new Map([[path, content]]));
	assert(problems.some((problem) => problem.includes("stale display text")));
});
