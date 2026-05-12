import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	loadAgentTrajectoryScenario,
	runAgentTrajectoryScenarioFile,
	scenarioResultToJunit,
	validateAgentTrajectoryScenario,
} from "../../src/server/agent-trajectory-scenarios.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"agent-trajectory-scenarios",
);

describe("agent trajectory scenarios", () => {
	it("validates and runs a successful scenario with replay labels and diff budget", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = loadAgentTrajectoryScenario(fixturePath);
		const result = runAgentTrajectoryScenarioFile(fixturePath, {
			baseDir: fixturesDir,
		});

		expect(scenario.id).toBe("local-diagnostic-success");
		expect(result.scenario.observedOutcome).toBe("pass");
		expect(result.run.replay).toBe(true);
		expect(result.run.scenarioId).toBe("local-diagnostic-success");
		expect(result.scenario.reviewLabels).toContain("platform_promotion_ready");
		expect(result.counts).toMatchObject({
			assertions: 8,
			failed: 0,
			toolCalls: 1,
			replayDeltas: 0,
			scoreFailures: 0,
		});
		expect(result.diff).toMatchObject({
			eventsDelta: -4,
			toolCallsDelta: -2,
			scoreFailuresDelta: 0,
		});
		expect(result.provenance.length).toBeGreaterThan(0);
		expect(result.platform.evidenceEventType).toBe(
			"maestro.events.eval.scored",
		);
	});

	it("keeps adversarial negative fixtures visible without making the corpus green by omission", () => {
		const fixturePath = join(
			fixturesDir,
			"adversarial-unsafe-tool-negative.json",
		);
		const result = runAgentTrajectoryScenarioFile(fixturePath, {
			baseDir: fixturesDir,
		});

		expect(result.scenario.expectedOutcome).toBe("fail");
		expect(result.scenario.observedOutcome).toBe("fail");
		expect(result.scenario.reviewLabels).toContain("unsafe_input");
		expect(result.assertions).toContainEqual(
			expect.objectContaining({
				id: "privileged-edit-forbidden",
				status: "fail",
			}),
		);
	});

	it("renders JUnit for CI annotations", () => {
		const fixturePath = join(fixturesDir, "hosted-degraded-recovery.json");
		const result = runAgentTrajectoryScenarioFile(fixturePath, {
			baseDir: fixturesDir,
		});
		const junit = scenarioResultToJunit(result);

		expect(junit).toContain("<testsuite");
		expect(junit).toContain('name="hosted-degraded-recovery"');
		expect(junit).toContain('failures="0"');
		expect(junit).toContain('name="degraded-labels-present"');
		expect(
			readFileSync(
				join(fixturesDir, "hosted-degraded-recovery.result.json"),
				"utf8",
			),
		).toContain('"observedOutcome": "pass"');
	});

	it("rejects unknown assertion kinds during validation", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.assertions[0].kind = "event.exsits";

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "unknown-kind-fixture"),
		).toThrow("unknown-kind-fixture.assertions[].kind must be one of");
	});

	it("rejects invalid expected outcomes during validation", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.expectedOutcome = "pas";

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "invalid-outcome"),
		).toThrow("invalid-outcome.expectedOutcome must be pass or fail");
	});

	it("rejects one-sided score diff inputs", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		delete scenario.source.candidateScorePath;

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "one-sided-score"),
		).toThrow(
			"one-sided-score.source baselineScorePath and candidateScorePath must be provided together",
		);
	});

	it("rejects one-sided trajectory diff inputs", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		delete scenario.source.candidateTrajectoryPath;

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "one-sided-trajectory"),
		).toThrow(
			"one-sided-trajectory.source baselineTrajectoryPath and candidateTrajectoryPath must be provided together",
		);
	});

	it("rejects score diff budgets without score inputs", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		delete scenario.source.baselineScorePath;
		delete scenario.source.candidateScorePath;

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "missing-score-diff-inputs"),
		).toThrow(
			"missing-score-diff-inputs.assertions[].maxAddedScoreFailures requires baselineScorePath and candidateScorePath",
		);
	});
});
