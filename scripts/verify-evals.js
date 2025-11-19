import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

function loadJSON(relativePath) {
	const absolute = join(repoRoot, relativePath);
	return JSON.parse(readFileSync(absolute, "utf8"));
}

function readFile(relativePath) {
	const absolute = join(repoRoot, relativePath);
	return readFileSync(absolute, "utf8");
}

const scenarios = loadJSON("evals/scenarios.json");

const validations = [
	{
		name: "read tool returns first line",
		actual: () => {
			const firstLine = readFile("README.md").split(/\r?\n/)[0] ?? "";
			return firstLine.trim();
		},
	},
];

let failures = 0;

for (const validation of validations) {
	const scenario = scenarios.find((s) => s.name === validation.name);
	if (!scenario) {
		console.error(`Missing eval scenario: ${validation.name}`);
		failures += 1;
		continue;
	}

	if (!scenario.expectedRegex) {
		console.error(
			`Scenario "${validation.name}" is missing expectedRegex; cannot verify`,
		);
		failures += 1;
		continue;
	}

	const regex = new RegExp(scenario.expectedRegex);
	const sample = validation.actual();

	if (!regex.test(sample)) {
		console.error(
			`Scenario "${validation.name}" expectedRegex ${scenario.expectedRegex} does not match sample "${sample}"`,
		);
		failures += 1;
	}
}

if (failures > 0) {
	console.error(`Eval verification failed (${failures} issue${failures === 1 ? "" : "s"}).`);
	process.exit(1);
}

console.log("Eval scenarios verified.");
