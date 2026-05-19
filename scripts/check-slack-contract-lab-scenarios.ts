import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaestroScenario } from "@evalops/contracts";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"agent-trajectory-scenarios",
);

const slackScenarioNames = [
	"slack-contract-progress-outcome.json",
	"slack-contract-unsafe-degraded.json",
] as const;

const requiredExternalRefKinds = [
	"ensembleTranscriptIds",
	"platformTraceIds",
	"platformWorkEnvelopeIds",
	"slackThreadRefs",
	"evidenceArtifactIds",
] as const;

const requiredTraceJoinKeys = [
	"ensemble_transcript_id",
	"platform_trace_id",
	"work_envelope_id",
] as const;

const forbiddenKeyPattern =
	/^(rawText|rawSlackText|prompt|modelResponse|toolArguments|toolOutput|commandOutput|connectorPayload|vfsBytes|artifactBytes)$/iu;
const secretPattern =
	/(xox[abp]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|BEGIN [A-Z ]+PRIVATE KEY|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertNoForbiddenPayload(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			assertNoForbiddenPayload(item, `${path}[${index}]`),
		);
		return;
	}
	if (!value || typeof value !== "object") {
		if (typeof value === "string") {
			assert(
				!secretPattern.test(value),
				`${path} appears to contain a secret or PII-like value`,
			);
		}
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		assert(!forbiddenKeyPattern.test(key), `${path}.${key} is forbidden`);
		assertNoForbiddenPayload(child, `${path}.${key}`);
	}
}

function scenarioPath(name: string): string {
	return join(fixturesDir, name);
}

function sourcePath(
	scenario: MaestroScenario,
	field: keyof MaestroScenario["source"],
): string {
	const source = scenario.source[field];
	assert(source, `${scenario.id}.source.${field} is required`);
	return join(fixturesDir, source);
}

function assertExternalRefs(scenario: MaestroScenario): void {
	assert(scenario.externalRefs, `${scenario.id}.externalRefs is required`);
	for (const kind of requiredExternalRefKinds) {
		const values = scenario.externalRefs[kind];
		assert(
			Array.isArray(values) && values.length > 0,
			`${scenario.id}.externalRefs.${kind} must not be empty`,
		);
	}
	for (const key of requiredTraceJoinKeys) {
		assert(
			scenario.platform.traceJoinKeys.includes(key),
			`${scenario.id}.platform.traceJoinKeys must include ${key}`,
		);
	}
	assert(
		scenario.assertions.some((assertion) => assertion.kind === "external.refs"),
		`${scenario.id} must assert external.refs`,
	);
}

function assertScenarioShape(scenario: MaestroScenario): void {
	assertExternalRefs(scenario);
	if (scenario.id === "slack-contract-progress-outcome") {
		assert.equal(scenario.expectedOutcome, "pass");
		for (const ruleId of [
			"slack-memory-lifecycle-accepted",
			"slack-evidence-artifact-linked",
			"slack-final-answer-quality",
		]) {
			assert(
				scenario.assertions.some(
					(assertion) =>
						assertion.kind === "score.finding" && assertion.ruleId === ruleId,
				),
				`${scenario.id} must assert ${ruleId}`,
			);
		}
		return;
	}
	if (scenario.id === "slack-contract-unsafe-degraded") {
		for (const label of [
			"degraded",
			"unsafe_input",
			"needs_human_review",
		] as const) {
			assert(
				scenario.reviewLabels.includes(label),
				`${scenario.id}.reviewLabels must include ${label}`,
			);
		}
		for (const ruleId of [
			"slack-unsafe-action-blocked",
			"slack-missing-evidence-degraded",
			"slack-useful-degraded-next-action",
			"slack-no-unsafe-tool-execution",
		]) {
			assert(
				scenario.assertions.some(
					(assertion) =>
						assertion.kind === "score.finding" && assertion.ruleId === ruleId,
				),
				`${scenario.id} must assert ${ruleId}`,
			);
		}
		return;
	}
	throw new Error(`Unexpected Slack contract scenario ${scenario.id}`);
}

function main(): void {
	const fixtureNames = readdirSync(fixturesDir)
		.filter((name) => name.startsWith("slack-contract-"))
		.filter((name) => name.endsWith(".json") && !name.endsWith(".result.json"))
		.sort();
	assert.deepEqual(
		fixtureNames,
		[...slackScenarioNames].sort(),
		"Slack contract-lab scenario fixture set drifted",
	);

	for (const name of fixtureNames) {
		const scenario = readJson(scenarioPath(name)) as MaestroScenario;
		assertNoForbiddenPayload(scenario, name);
		assertScenarioShape(scenario);
		for (const field of [
			"trajectoryPath",
			"replayPath",
			"scorePath",
			"inspectionPath",
		] as const) {
			assertNoForbiddenPayload(
				readJson(sourcePath(scenario, field)),
				`${name}.${field}`,
			);
		}
	}
	console.log(`Checked ${fixtureNames.length} Slack contract-lab scenario(s).`);
}

main();
