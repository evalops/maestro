import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScriptedScenario } from "../src/agent/providers/scripted.js";
import {
	evaluateScriptedScenario,
	scriptedScenarioResultToJunit,
} from "../src/server/scripted-scenario-runner.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"scripted-replay",
);

function fixtureNames(): string[] {
	return readdirSync(fixturesDir)
		.filter((name) => name.endsWith(".json") && !name.endsWith(".result.json"))
		.sort();
}

function checkJunit(
	name: string,
	result: ReturnType<typeof evaluateScriptedScenario>,
	update: boolean,
): void {
	const expectedPath = join(
		fixturesDir,
		"junit",
		name.replace(/\.json$/u, ".xml"),
	);
	const actual = scriptedScenarioResultToJunit(result);
	if (update) {
		writeFileSync(expectedPath, actual);
		return;
	}
	assert(
		existsSync(expectedPath),
		`missing scripted scenario JUnit fixture ${expectedPath}; rerun with --update`,
	);
	assert.equal(
		actual,
		readFileSync(expectedPath, "utf8"),
		`${name} JUnit fixture drifted`,
	);
}

async function main(): Promise<void> {
	const update = process.argv.includes("--update");
	const junitDir = join(fixturesDir, "junit");
	if (update) {
		mkdirSync(junitDir, { recursive: true });
	}

	for (const name of fixtureNames()) {
		const scenario = loadScriptedScenario(join(fixturesDir, name));
		const result = evaluateScriptedScenario(scenario, { baseDir: fixturesDir });
		assert.equal(
			result.scenario.observedOutcome,
			result.scenario.expectedOutcome,
			`${name} observed ${result.scenario.observedOutcome}; expected ${result.scenario.expectedOutcome}`,
		);
		checkJunit(name, result, update);
		assert(
			result.counts.assertions > 0,
			`${name} must contain at least one scripted assertion`,
		);
	}
	console.log(
		`${update ? "Updated" : "Checked"} ${fixtureNames().length} scripted scenario fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
