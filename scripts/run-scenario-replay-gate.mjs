#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { reportScenarioReplayGateFailure } from "./scenario-replay-governance.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const maestroBin =
	process.env.MAESTRO_BIN ??
	join(repoRoot, "target", "debug", "maestro");

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

function concurrencyLimit(fixtureCount) {
	const configured = process.env.SCENARIO_REPLAY_CONCURRENCY;
	if (!configured) return Math.min(4, fixtureCount);
	if (!/^\d+$/u.test(configured) || Number(configured) < 1) {
		throw new Error(
			`SCENARIO_REPLAY_CONCURRENCY must be a positive integer; received ${configured}`,
		);
	}
	return Math.min(Number(configured), fixtureCount);
}

function trace(event, fields = {}) {
	if (process.env.MAESTRO_SCENARIO_TRACE === "0") return;
	console.error(
		JSON.stringify({
			component: "scenario-replay-gate",
			event,
			timestamp: new Date().toISOString(),
			...fields,
		}),
	);
}

function runScenario(group, fixtureName, worker) {
	const fixturePath = join(group.dir, fixtureName);
	const outputDir = join(junitDir, group.name);
	mkdirSync(outputDir, { recursive: true });
	const junitPath = join(outputDir, fixtureName.replace(/\.json$/u, ".xml"));
	const args = [
		"scenario",
		"run",
		relative(repoRoot, fixturePath),
		"--junit",
		relative(repoRoot, junitPath),
		"--json",
	];
	const startedAt = performance.now();
	const startedIso = new Date().toISOString();
	trace("fixture_started", { group: group.name, fixture: fixtureName, worker });
	return new Promise((resolve) => {
		const child = spawn(maestroBin, args, {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
			trace("fixture_completed", {
				group: group.name,
				fixture: fixtureName,
				worker,
				status: "fail",
				failureKind: "spawn",
				exitCode: null,
				durationMs,
				error: error.message,
			});
			resolve({
				group: group.name,
				fixture: fixtureName,
				junitPath: relative(repoRoot, junitPath),
				status: "fail",
				failureKind: "spawn",
				exitCode: null,
				stdout: stdout.trim(),
				stderr: [stderr.trim(), error.message].filter(Boolean).join("\n"),
				worker,
				startedAt: startedIso,
				durationMs,
			});
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
			if (exitCode !== 0) {
				trace("fixture_completed", {
					group: group.name,
					fixture: fixtureName,
					worker,
					status: "fail",
					exitCode,
					durationMs,
				});
				resolve({
					group: group.name,
					fixture: fixtureName,
					junitPath: relative(repoRoot, junitPath),
					status: "fail",
					exitCode,
					stdout: stdout.trim(),
					stderr: stderr.trim(),
					worker,
					startedAt: startedIso,
					durationMs,
				});
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim());
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
				const result = {
					group: group.name,
					fixture: fixtureName,
					junitPath: relative(repoRoot, junitPath),
					status: gateFailed ? "fail" : "pass",
					failureKind: gateFailed ? "gate" : undefined,
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
					worker,
					startedAt: startedIso,
					durationMs,
				};
				trace("fixture_completed", {
					group: group.name,
					fixture: fixtureName,
					worker,
					status: result.status,
					exitCode: 0,
					durationMs,
				});
				resolve(result);
			} catch (error) {
				trace("fixture_completed", {
					group: group.name,
					fixture: fixtureName,
					worker,
					status: "fail",
					exitCode: 0,
					durationMs,
					error: error instanceof Error ? error.message : String(error),
				});
				resolve({
					group: group.name,
					fixture: fixtureName,
					junitPath: relative(repoRoot, junitPath),
					status: "fail",
					failureKind: "parse",
					stdout: stdout.trim(),
					stderr: [
						stderr.trim(),
						error instanceof Error ? error.message : String(error),
					].filter(Boolean).join("\n"),
					worker,
					startedAt: startedIso,
					durationMs,
				});
			}
		});
	});
}

async function runScenarios(tasks, limit) {
	const results = new Array(tasks.length);
	let nextIndex = 0;
	async function workerLoop(worker) {
		while (true) {
			const index = nextIndex++;
			if (index >= tasks.length) return;
			const task = tasks[index];
			results[index] = await runScenario(task.group, task.fixture, worker);
		}
	}
	await Promise.all(
		Array.from({ length: limit }, (_, index) => workerLoop(index + 1)),
	);
	return results;
}

async function main() {
	mkdirSync(junitDir, { recursive: true });
	const tasks = [];
	for (const group of fixtureGroups) {
		for (const fixtureName of fixtureFiles(group.dir)) {
			tasks.push({ group, fixture: fixtureName });
		}
	}
	const concurrency = concurrencyLimit(tasks.length);
	trace("gate_started", { fixtures: tasks.length, concurrency });
	const gateStartedAt = performance.now();
	const results = await runScenarios(tasks, concurrency);
	const gateDurationMs = Math.round((performance.now() - gateStartedAt) * 100) / 100;
	trace("gate_completed", {
		fixtures: results.length,
		concurrency,
		durationMs: gateDurationMs,
		failed: results.filter((result) => result.status !== "pass").length,
	});
	const summary = {
		generatedAt: new Date().toISOString(),
		fixtures: results.length,
		concurrency,
		durationMs: gateDurationMs,
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
			`Concurrency: ${summary.concurrency}; wall-clock duration: ${summary.durationMs} ms.`,
			`Release-blocking fixtures: ${summary.releaseBlockingFixtures}; workspace manifests: ${summary.workspaceManifests}.`,
			"",
			"| Group | Fixture | Outcome | Gate | Workspace | Assertions | JUnit |",
			"| --- | --- | --- | --- | --- | ---: | --- |",
			...results.map((result) => {
				const failureLabel =
					result.failureKind ?? result.exitCode ?? "gate";
				return `| ${result.group} | ${result.fixture} | ${result.status === "pass" ? `${result.observedOutcome}/${result.expectedOutcome}` : `failed (${failureLabel})`} | ${result.releaseBlocking ? `${result.releaseGateTier}:${result.releaseGateSatisfied ? "pass" : "fail"}` : "not-blocking"} | ${result.workspaceManifestId ? `${result.workspaceManifestId} (${result.hydrationMode ?? "unknown"})` : ""} | ${result.assertions ?? ""} | ${result.junitPath} |`;
			}),
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
