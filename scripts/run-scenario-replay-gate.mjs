#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { reportScenarioReplayGateFailure } from "./scenario-replay-governance.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function valueAfter(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

const junitDir = join(
	repoRoot,
	valueAfter("--junit-dir", "tmp/scenario-replay"),
);

const fixtureGroups = [
	{
		name: "agent-trajectory",
		dir: join(repoRoot, "test/fixtures/agent-trajectory-scenarios"),
	},
	{
		name: "scripted-replay",
		dir: join(repoRoot, "test/fixtures/scripted-replay"),
	},
];

function fixtureFiles(dir) {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.endsWith(".result.json"))
		.sort();
}

function runScenario(group, fixtureName) {
	const fixturePath = join(group.dir, fixtureName);
	const outputDir = join(junitDir, group.name);
	mkdirSync(outputDir, { recursive: true });
	const junitPath = join(outputDir, fixtureName.replace(/\.json$/u, ".xml"));
	const args = [
		"--import",
		"tsx",
		"src/cli.ts",
		"scenario",
		"run",
		relative(repoRoot, fixturePath),
		"--junit",
		relative(repoRoot, junitPath),
		"--json",
	];
	const result = spawnSync(process.execPath, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		return {
			group: group.name,
			fixture: fixtureName,
			junitPath: relative(repoRoot, junitPath),
			status: "fail",
			exitCode: result.status,
			stdout: (result.stdout ?? "").trim(),
			stderr: (result.stderr ?? "").trim(),
		};
	}
	const parsed = JSON.parse(result.stdout.trim());
	const releaseGate = parsed.releaseGate;
	const gateFailed =
		releaseGate?.releaseBlocking === true && releaseGate.satisfied !== true;
	const gateFailureMessage = gateFailed
		? [
				"Release-blocking scenario gate failed.",
				releaseGate.missingArtifacts?.length
					? `Missing artifacts: ${releaseGate.missingArtifacts.join(", ")}.`
					: undefined,
				releaseGate.budgetViolations?.length
					? `Budget violations: ${releaseGate.budgetViolations.join(", ")}.`
					: undefined,
				releaseGate.policyViolations?.length
					? `Policy violations: ${releaseGate.policyViolations.join(", ")}.`
					: undefined,
			]
				.filter(Boolean)
				.join(" ")
		: undefined;
	return {
		group: group.name,
		fixture: fixtureName,
		junitPath: relative(repoRoot, junitPath),
		status: gateFailed ? "fail" : "pass",
		scenarioId: parsed.scenario?.id,
		expectedOutcome: parsed.scenario?.expectedOutcome,
		observedOutcome: parsed.scenario?.observedOutcome,
		releaseGateTier: releaseGate?.tier,
		releaseBlocking: releaseGate?.releaseBlocking === true,
		releaseGateSatisfied: releaseGate?.satisfied,
		workspaceManifestId: parsed.workspace?.manifestId,
		hydrationMode: parsed.workspace?.hydrationMode,
		assertions: parsed.counts?.assertions,
		failed: parsed.counts?.failed,
		warnings: parsed.counts?.warnings,
		stderr: gateFailureMessage,
	};
}

async function main() {
	mkdirSync(junitDir, { recursive: true });
	const results = [];
	for (const group of fixtureGroups) {
		for (const fixtureName of fixtureFiles(group.dir)) {
			results.push(runScenario(group, fixtureName));
		}
	}
	const summary = {
		generatedAt: new Date().toISOString(),
		fixtures: results.length,
		releaseBlockingFixtures: results.filter(
			(result) => result.releaseBlocking === true,
		).length,
		workspaceManifests: results.filter(
			(result) => result.workspaceManifestId,
		).length,
		results,
	};
	const failures = results.filter((result) => result.status !== "pass");
	writeFileSync(
		join(junitDir, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	writeFileSync(
		join(junitDir, "summary.md"),
		[
			"# Scenario Replay Gate",
			"",
			`Ran ${results.length} fixture(s) through \`maestro scenario run\`.`,
			`Release-blocking fixtures: ${summary.releaseBlockingFixtures}; workspace manifests: ${summary.workspaceManifests}.`,
			"",
			"| Group | Fixture | Outcome | Gate | Workspace | Assertions | JUnit |",
			"| --- | --- | --- | --- | --- | ---: | --- |",
			...results.map(
				(result) =>
					`| ${result.group} | ${result.fixture} | ${result.status === "pass" ? `${result.observedOutcome}/${result.expectedOutcome}` : `failed (${result.exitCode ?? "gate"})`} | ${result.releaseBlocking ? `${result.releaseGateTier}:${result.releaseGateSatisfied ? "pass" : "fail"}` : "not-blocking"} | ${result.workspaceManifestId ? `${result.workspaceManifestId} (${result.hydrationMode ?? "unknown"})` : ""} | ${result.assertions ?? ""} | ${result.junitPath} |`,
			),
			failures.length > 0 ? "" : undefined,
			...failures.flatMap((result) => [
				`## Failure: ${result.group}/${result.fixture}`,
				"",
				"```text",
				result.stderr || result.stdout || "No output captured.",
				"```",
				"",
			]),
			"",
		]
			.filter((line) => line !== undefined)
			.join("\n"),
	);
	if (process.env.GITHUB_STEP_SUMMARY) {
		writeFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`${readFileSync(join(junitDir, "summary.md"), "utf8")}\n`,
			{ flag: "a" },
		);
	}
	console.log(
		`Scenario replay gate ran ${results.length} fixture(s); artifacts in ${relative(repoRoot, junitDir)}.`,
	);
	if (failures.length > 0) {
		await reportScenarioReplayGateFailure({ summary, failures });
		throw new Error(
			`Scenario replay gate failed ${failures.length}/${results.length} fixture(s).`,
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
