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
import {
	runAgentTrajectoryScenarioFile,
	scenarioResultToJunit,
} from "../src/server/agent-trajectory-scenarios.js";
import type { AgentTrajectoryScenarioResult } from "../src/server/agent-trajectory-scenarios.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"agent-trajectory-scenarios",
);

function fixtureNames(): string[] {
	return readdirSync(fixturesDir)
		.filter((name) => name.endsWith(".json") && !name.endsWith(".result.json"))
		.sort();
}

function normalizeResult(
	result: AgentTrajectoryScenarioResult,
): AgentTrajectoryScenarioResult {
	const { generatedAt: _generatedAt, ...run } = result.run;
	return {
		...result,
		run: {
			...run,
			generatedAt: "<redacted>",
		},
	};
}

function serializeResult(result: AgentTrajectoryScenarioResult): string {
	return `${JSON.stringify(normalizeResult(result), null, "\t")}\n`;
}

function checkResult(
	name: string,
	result: AgentTrajectoryScenarioResult,
	update: boolean,
): void {
	const expectedOutcome = result.scenario.expectedOutcome;
	assert.equal(
		result.scenario.observedOutcome,
		expectedOutcome,
		`${name} observed ${result.scenario.observedOutcome}; expected ${expectedOutcome}`,
	);

	const expectedPath = join(fixturesDir, name.replace(/\.json$/u, ".result.json"));
	const actual = normalizeResult(result);
	if (update) {
		writeFileSync(expectedPath, serializeResult(result));
		return;
	}
	assert(
		existsSync(expectedPath),
		`missing scenario result fixture ${expectedPath}; rerun with --update`,
	);
	assert.deepEqual(
		actual,
		JSON.parse(readFileSync(expectedPath, "utf8")),
		`${name} result drifted`,
	);
}

function checkJunit(
	name: string,
	result: AgentTrajectoryScenarioResult,
	update: boolean,
): void {
	const expectedPath = join(
		fixturesDir,
		"junit",
		name.replace(/\.json$/u, ".xml"),
	);
	const actual = scenarioResultToJunit(result);
	if (update) {
		writeFileSync(expectedPath, actual);
		return;
	}
	assert(
		existsSync(expectedPath),
		`missing scenario JUnit fixture ${expectedPath}; rerun with --update`,
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
		const result = runAgentTrajectoryScenarioFile(join(fixturesDir, name), {
			baseDir: fixturesDir,
		});
		checkResult(name, result, update);
		checkJunit(name, result, update);
	}
	console.log(
		`${update ? "Updated" : "Checked"} ${fixtureNames().length} agent trajectory scenario fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
