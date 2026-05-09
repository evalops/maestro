import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import {
	DEFAULT_SCENARIO_PACK,
	handleScenarioCommand,
	loadScenarioPack,
	runScenarioPack,
	validateScenarioPack,
} from "../src/cli/commands/scenario.js";

async function loadMutableDefaultPack() {
	const pack = await loadScenarioPack(DEFAULT_SCENARIO_PACK);
	return JSON.parse(JSON.stringify(pack)) as typeof pack;
}

describe("complex task scenario pack", () => {
	it("validates the default EvalOps complex-task gauntlet pack", async () => {
		const pack = await loadScenarioPack(DEFAULT_SCENARIO_PACK);

		expect(validateScenarioPack(pack)).toEqual([]);
		expect(pack.scenarios.map((scenario) => scenario.id)).toEqual([
			"slack-progress-audit",
			"browser-computer-grant-task",
			"github-write-task",
			"deploy-verification-task",
			"memory-conflict-task",
		]);
		expect(pack.scenarios.map((scenario) => scenario.tier)).toEqual([
			"smoke",
			"gauntlet",
			"regression",
			"gauntlet",
			"regression",
		]);
	});

	it("runs deterministic scenario replay and emits passing results", async () => {
		const pack = await loadScenarioPack(DEFAULT_SCENARIO_PACK);
		const report = runScenarioPack(pack);

		expect(report.status).toBe("passed");
		expect(report.selectedTiers).toEqual(["smoke", "regression", "gauntlet"]);
		expect(report.results).toHaveLength(5);
		expect(report.results.flatMap((result) => result.assertions)).toContain(
			"final-status:blocked",
		);
		expect(report.results.flatMap((result) => result.assertions)).toContain(
			"blocker:browser_computer_grant_required",
		);
		expect(report.results.flatMap((result) => result.assertions)).toContain(
			"side-effect:cerebro.memory.score:complex-agent-memory-gauntlet",
		);
	});

	it("filters deterministic replay by scenario ladder tier", async () => {
		const pack = await loadScenarioPack(DEFAULT_SCENARIO_PACK);
		const regressionReport = runScenarioPack(pack, { maxTier: "regression" });
		const smokeReport = runScenarioPack(pack, { tier: "smoke" });

		expect(regressionReport.status).toBe("passed");
		expect(regressionReport.selectedTiers).toEqual(["smoke", "regression"]);
		expect(regressionReport.results.map((result) => result.id)).toEqual([
			"slack-progress-audit",
			"github-write-task",
			"memory-conflict-task",
		]);
		expect(regressionReport.results.map((result) => result.tier)).toEqual([
			"smoke",
			"regression",
			"regression",
		]);
		expect(smokeReport.selectedTiers).toEqual(["smoke"]);
		expect(smokeReport.results.map((result) => result.id)).toEqual([
			"slack-progress-audit",
		]);
	});

	it("parses scenario command args without dropping replay flags", () => {
		const parsed = parseArgs([
			"scenario",
			"run",
			DEFAULT_SCENARIO_PACK,
			"--junit",
			"artifacts/complex-task-gauntlet/junit.xml",
			"--json",
		]);

		expect(parsed.command).toBe("scenario");
		expect(parsed.commandArgs).toEqual([
			"run",
			DEFAULT_SCENARIO_PACK,
			"--junit",
			"artifacts/complex-task-gauntlet/junit.xml",
			"--json",
		]);
	});

	it("passes scenario ladder flags through top-level argument parsing", () => {
		const parsed = parseArgs([
			"scenario",
			"run",
			DEFAULT_SCENARIO_PACK,
			"--max-tier",
			"regression",
			"--report",
			"artifacts/complex-task-gauntlet/regression.json",
		]);

		expect(parsed.command).toBe("scenario");
		expect(parsed.commandArgs).toEqual([
			"run",
			DEFAULT_SCENARIO_PACK,
			"--max-tier",
			"regression",
			"--report",
			"artifacts/complex-task-gauntlet/regression.json",
		]);
	});

	it("writes JUnit and JSON report artifacts for CI", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const reportPath = join(tempDir, "report.json");
		const junitPath = join(tempDir, "junit.xml");

		await handleScenarioCommand([
			"run",
			DEFAULT_SCENARIO_PACK,
			"--report",
			reportPath,
			"--junit",
			junitPath,
		]);

		const report = JSON.parse(await readFile(reportPath, "utf8")) as {
			status?: string;
			selectedTiers?: string[];
			results?: unknown[];
		};
		const junit = await readFile(junitPath, "utf8");

		expect(report.status).toBe("passed");
		expect(report.selectedTiers).toEqual(["smoke", "regression", "gauntlet"]);
		expect(report.results).toHaveLength(5);
		expect(junit).toContain("<testsuite");
		expect(junit).toContain('classname="maestro.scenario.gauntlet"');
		expect(junit).toContain("browser-computer-grant-task");
	});

	it("writes filtered scenario ladder artifacts for faster regression CI", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const reportPath = join(tempDir, "report.json");
		const junitPath = join(tempDir, "junit.xml");

		await handleScenarioCommand([
			"run",
			DEFAULT_SCENARIO_PACK,
			"--max-tier",
			"regression",
			"--report",
			reportPath,
			"--junit",
			junitPath,
		]);

		const report = JSON.parse(await readFile(reportPath, "utf8")) as {
			selectedTiers?: string[];
			results?: Array<{ id?: string; tier?: string }>;
		};
		const junit = await readFile(junitPath, "utf8");

		expect(report.selectedTiers).toEqual(["smoke", "regression"]);
		expect(report.results?.map((result) => result.id)).toEqual([
			"slack-progress-audit",
			"github-write-task",
			"memory-conflict-task",
		]);
		expect(report.results?.map((result) => result.tier)).toEqual([
			"smoke",
			"regression",
			"regression",
		]);
		expect(junit).toContain('classname="maestro.scenario.regression"');
		expect(junit).not.toContain("deploy-verification-task");
	});

	it("rejects --junit when the value is missing or another flag", async () => {
		await expect(
			handleScenarioCommand(["run", DEFAULT_SCENARIO_PACK, "--junit"]),
		).rejects.toThrow(
			"Invalid scenario arguments: --junit requires a non-flag file path",
		);

		await expect(
			handleScenarioCommand([
				"run",
				DEFAULT_SCENARIO_PACK,
				"--junit",
				"--json",
			]),
		).rejects.toThrow(
			"Invalid scenario arguments: --junit requires a non-flag file path",
		);
	});

	it("rejects --report when the value is missing or another flag", async () => {
		await expect(
			handleScenarioCommand(["run", DEFAULT_SCENARIO_PACK, "--report"]),
		).rejects.toThrow(
			"Invalid scenario arguments: --report requires a non-flag file path",
		);

		await expect(
			handleScenarioCommand([
				"run",
				DEFAULT_SCENARIO_PACK,
				"--report",
				"--json",
			]),
		).rejects.toThrow(
			"Invalid scenario arguments: --report requires a non-flag file path",
		);
	});

	it("rejects invalid or conflicting scenario tier filters", async () => {
		await expect(
			handleScenarioCommand(["run", DEFAULT_SCENARIO_PACK, "--tier", "daily"]),
		).rejects.toThrow(
			"Invalid scenario arguments: --tier requires one of: smoke, regression, gauntlet",
		);

		await expect(
			handleScenarioCommand([
				"run",
				DEFAULT_SCENARIO_PACK,
				"--tier",
				"smoke",
				"--max-tier",
				"regression",
			]),
		).rejects.toThrow(
			"Invalid scenario arguments: --tier and --max-tier cannot be used together",
		);
	});

	it("requires the default pack to carry every scenario ladder tier", async () => {
		const pack = await loadMutableDefaultPack();
		pack.scenarios = pack.scenarios.filter(
			(scenario) => scenario.tier !== "gauntlet",
		);

		expect(validateScenarioPack(pack)).toContain(
			"missing required scenario tier: gauntlet",
		);
	});

	it("rejects malformed scenarios instead of dropping them from the pack", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const malformedPath = join(tempDir, "malformed-pack.json");
		const rawPack = JSON.parse(
			await readFile(DEFAULT_SCENARIO_PACK, "utf8"),
		) as Record<string, unknown> & { scenarios: unknown[] };
		rawPack.scenarios.push({
			id: "malformed-extra-scenario",
			title: "Malformed extra scenario",
		});

		await writeFile(malformedPath, `${JSON.stringify(rawPack, null, 2)}\n`);

		await expect(loadScenarioPack(malformedPath)).rejects.toThrow(
			"Scenario pack is malformed",
		);
	});

	it("requires grant.reviewed for each gated browser or computer connector", async () => {
		const pack = await loadMutableDefaultPack();
		const scenario = pack.scenarios.find(
			(candidate) => candidate.id === "browser-computer-grant-task",
		);
		expect(scenario).toBeDefined();
		if (!scenario) return;
		scenario.expect.sideEffects = scenario.expect.sideEffects.filter(
			(effect) =>
				!(effect.kind === "grant.reviewed" && effect.target === "computer"),
		);

		expect(validateScenarioPack(pack)).toContain(
			"browser-computer-grant-task: computer scenarios must assert grant.reviewed:computer",
		);
	});

	it("rejects malformed expected side effects instead of dropping them", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const malformedPath = join(tempDir, "malformed-side-effect-pack.json");
		const rawPack = JSON.parse(
			await readFile(DEFAULT_SCENARIO_PACK, "utf8"),
		) as Record<string, unknown> & {
			scenarios: Array<{
				id?: string;
				expect?: { sideEffects?: Array<Record<string, unknown>> };
			}>;
		};
		const scenario = rawPack.scenarios.find(
			(candidate) => candidate.id === "slack-progress-audit",
		);
		expect(scenario?.expect?.sideEffects).toBeDefined();
		if (!scenario?.expect?.sideEffects) return;
		scenario.expect.sideEffects.push({ kind: "slack.final_reply" });

		await writeFile(malformedPath, `${JSON.stringify(rawPack, null, 2)}\n`);

		await expect(loadScenarioPack(malformedPath)).rejects.toThrow(
			"Scenario pack is malformed",
		);
	});

	it("rejects malformed replay events instead of dropping them", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const malformedPath = join(tempDir, "malformed-replay-event-pack.json");
		const rawPack = JSON.parse(
			await readFile(DEFAULT_SCENARIO_PACK, "utf8"),
		) as Record<string, unknown> & {
			scenarios: Array<{
				id?: string;
				replay?: { events?: Array<Record<string, unknown>> };
			}>;
		};
		const scenario = rawPack.scenarios.find(
			(candidate) => candidate.id === "slack-progress-audit",
		);
		expect(scenario?.replay?.events).toBeDefined();
		if (!scenario?.replay?.events) return;
		scenario.replay.events.push({ text: "missing kind" });

		await writeFile(malformedPath, `${JSON.stringify(rawPack, null, 2)}\n`);

		await expect(loadScenarioPack(malformedPath)).rejects.toThrow(
			"Scenario pack is malformed",
		);
	});

	it("rejects malformed replay side effects instead of dropping them", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-scenario-"));
		const malformedPath = join(
			tempDir,
			"malformed-replay-side-effect-pack.json",
		);
		const rawPack = JSON.parse(
			await readFile(DEFAULT_SCENARIO_PACK, "utf8"),
		) as Record<string, unknown> & {
			scenarios: Array<{
				id?: string;
				replay?: { sideEffects?: Array<Record<string, unknown>> };
			}>;
		};
		const scenario = rawPack.scenarios.find(
			(candidate) => candidate.id === "slack-progress-audit",
		);
		expect(scenario?.replay?.sideEffects).toBeDefined();
		if (!scenario?.replay?.sideEffects) return;
		scenario.replay.sideEffects.push({
			kind: "slack.final_reply",
			target: "evalops-alerts",
		});

		await writeFile(malformedPath, `${JSON.stringify(rawPack, null, 2)}\n`);

		await expect(loadScenarioPack(malformedPath)).rejects.toThrow(
			"Scenario pack is malformed",
		);
	});

	it("requires explicit blocker expectations for blocked scenarios", async () => {
		const pack = await loadMutableDefaultPack();
		const scenario = pack.scenarios.find(
			(candidate) => candidate.id === "browser-computer-grant-task",
		);
		expect(scenario).toBeDefined();
		if (!scenario) return;
		scenario.expect.blockers = [];

		expect(validateScenarioPack(pack)).toContain(
			"browser-computer-grant-task: blocked scenarios require blockers",
		);
	});

	it("fails replay when actual final status differs from the expectation", async () => {
		const pack = await loadMutableDefaultPack();
		const scenario = pack.scenarios.find(
			(candidate) => candidate.id === "browser-computer-grant-task",
		);
		expect(scenario).toBeDefined();
		if (!scenario) return;
		scenario.replay.finalStatus = "completed";

		const report = runScenarioPack(pack);
		const result = report.results.find(
			(candidate) => candidate.id === "browser-computer-grant-task",
		);

		expect(report.status).toBe("failed");
		expect(result?.errors).toContain(
			"browser-computer-grant-task: final status mismatch, expected blocked but replay ended completed",
		);
	});

	it("matches required completion artifact across all artifact events", async () => {
		const pack = await loadMutableDefaultPack();
		const scenario = pack.scenarios.find(
			(candidate) => candidate.id === "slack-progress-audit",
		);
		expect(scenario).toBeDefined();
		if (!scenario) return;
		const artifactIndex = scenario.replay.events.findIndex(
			(event) => event.kind === "artifact.created",
		);
		scenario.replay.events.splice(artifactIndex, 0, {
			kind: "artifact.created",
			text: "Intermediate artifact is ready.",
			artifact: {
				schema: "evalops.complex_task.intermediate.v1",
				path: "vfs://runs/run-complex-gauntlet-slack/artifacts/intermediate.json",
			},
		});

		const report = runScenarioPack(pack);
		const result = report.results.find(
			(candidate) => candidate.id === "slack-progress-audit",
		);

		expect(report.status).toBe("passed");
		expect(result?.assertions).toContain(
			"artifact-schema:evalops.complex_task.slack_completion.v1",
		);
		expect(result?.assertions).toContain(
			"artifact-path:vfs://runs/run-complex-gauntlet-slack/artifacts/slack-completion.json",
		);
	});
});
