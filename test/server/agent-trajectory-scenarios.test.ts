import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const workspaceManifestFixturePath = join(
	fixturesDir,
	"..",
	"scenario-workspace-manifests",
	"local-diagnostic-workspace-manifest.json",
);

function workspaceManifestFixture(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(workspaceManifestFixturePath, "utf8"),
	) as Record<string, unknown>;
}

function runFixtureWithWorkspaceManifest(
	manifest: Record<string, unknown>,
	label: string,
) {
	const tempDir = mkdtempSync(join(tmpdir(), `maestro-scenario-${label}-`));
	try {
		const scenario = JSON.parse(
			readFileSync(join(fixturesDir, "local-diagnostic-success.json"), "utf8"),
		);
		const manifestPath = join(tempDir, "workspace-manifest.json");
		const scenarioPath = join(tempDir, "scenario.json");
		scenario.source.workspaceManifestPath = manifestPath;
		writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
		writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
		return runAgentTrajectoryScenarioFile(scenarioPath, {
			baseDir: fixturesDir,
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

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
		expect(result.releaseGate).toMatchObject({
			releaseBlocking: true,
			tier: "smoke",
			satisfied: true,
			missingArtifacts: [],
			budgetViolations: [],
			policyViolations: [],
		});
		expect(result.workspace).toMatchObject({
			manifestId: "workspace-local-diagnostic-artifact-1",
			hydrationMode: "fixture_workspace",
			files: 3,
			toolAdapters: 1,
		});
		expect(result.counts).toMatchObject({
			assertions: 9,
			failed: 0,
			toolCalls: 1,
			replayDeltas: 0,
			scoreFailures: 0,
			workspaceFiles: 3,
			toolAdapters: 1,
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

		const junit = scenarioResultToJunit(result);
		expect(junit).toContain('failures="0"');
		expect(junit).toContain("Expected failing assertion observed");
		expect(junit).not.toContain("<failure");
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

	it("carries external transcript and trace refs through Slack contract scenarios", () => {
		const fixturePath = join(
			fixturesDir,
			"slack-contract-progress-outcome.json",
		);
		const scenario = loadAgentTrajectoryScenario(fixturePath);
		const result = runAgentTrajectoryScenarioFile(fixturePath, {
			baseDir: fixturesDir,
		});

		expect(scenario.externalRefs?.ensembleTranscriptIds).toContain(
			"slack-contract-lab/dev/thread-redacted-0007",
		);
		expect(result.externalRefs?.platformWorkEnvelopeIds).toContain(
			"we-slack-contract-dev-0007",
		);
		expect(result.assertions).toContainEqual(
			expect.objectContaining({
				id: "external-refs-present",
				status: "pass",
			}),
		);
	});

	it("renders outcome mismatches as JUnit failures", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const result = runAgentTrajectoryScenarioFile(fixturePath, {
			baseDir: fixturesDir,
		});
		const junit = scenarioResultToJunit({
			...result,
			scenario: {
				...result.scenario,
				expectedOutcome: "fail",
			},
		});

		expect(junit).toContain('name="scenario-outcome"');
		expect(junit).toContain('failures="1"');
		expect(junit).toContain("Observed outcome pass; expected fail.");
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

	it("rejects release-blocking gates without workspace manifests", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		delete scenario.source.workspaceManifestPath;

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "missing-workspace-gate"),
		).toThrow(
			"missing-workspace-gate.releaseGate requires workspace_manifest but source.workspaceManifestPath is missing",
		);
	});

	it("rejects workspace manifest assertions without a manifest source", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		delete scenario.releaseGate;
		delete scenario.source.workspaceManifestPath;

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "missing-workspace-assertion"),
		).toThrow(
			"missing-workspace-assertion.assertions[].kind workspace.manifest requires source.workspaceManifestPath",
		);
	});

	it("rejects release-blocking workspace gates without a workspace assertion", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.assertions = scenario.assertions.filter(
			(assertion: { kind?: string }) => assertion.kind !== "workspace.manifest",
		);

		expect(() =>
			validateAgentTrajectoryScenario(
				scenario,
				"missing-workspace-gate-assertion",
			),
		).toThrow(
			"missing-workspace-gate-assertion.releaseGate release-blocking workspace_manifest gates must include a workspace.manifest assertion",
		);
	});

	it("rejects warning-only workspace gates for release-blocking scenarios", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		const workspaceAssertion = scenario.assertions.find(
			(assertion: { kind?: string }) => assertion.kind === "workspace.manifest",
		);
		workspaceAssertion.severity = "warning";

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "warning-workspace-gate"),
		).toThrow(
			"warning-workspace-gate.releaseGate release-blocking workspace_manifest assertions must use error severity",
		);
	});

	it("rejects malformed workspace assertion arrays before evaluation", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		const workspaceAssertion = scenario.assertions.find(
			(assertion: { kind?: string }) => assertion.kind === "workspace.manifest",
		);
		workspaceAssertion.requiredWorkspaceFiles = "package.json";

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "malformed-workspace-files"),
		).toThrow(
			"malformed-workspace-files.assertions[].requiredWorkspaceFiles must contain non-empty strings",
		);

		workspaceAssertion.requiredWorkspaceFiles = ["package.json"];
		workspaceAssertion.requiredToolAdapters = "edit";
		expect(() =>
			validateAgentTrajectoryScenario(scenario, "malformed-tool-adapters"),
		).toThrow(
			"malformed-tool-adapters.assertions[].requiredToolAdapters must contain non-empty strings",
		);
	});

	it("rejects malformed workspace manifests before summary evaluation", () => {
		const manifest = workspaceManifestFixture();
		manifest.files = "package.json";

		expect(() =>
			runFixtureWithWorkspaceManifest(manifest, "malformed-manifest"),
		).toThrow(/workspace manifest at .*\.files must be an array/u);
	});

	it("marks release gates unsatisfied when workspace redaction is unsafe", () => {
		const manifest = workspaceManifestFixture();
		const redaction = manifest.redaction as Record<string, unknown>;
		redaction.rawPromptsIncluded = true;

		const result = runFixtureWithWorkspaceManifest(
			manifest,
			"unsafe-redaction",
		);

		expect(result.releaseGate).toMatchObject({
			satisfied: false,
			policyViolations: [
				"workspace manifest did not confirm raw prompts were excluded",
			],
		});
		expect(result.assertions).toContainEqual(
			expect.objectContaining({
				id: "workspace-manifest-ready",
				status: "fail",
			}),
		);
	});

	it("rejects external ref assertions without required ref kinds", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.externalRefs = {
			ensembleTranscriptIds: ["slack-contract-lab/dev/thread-redacted-0001"],
		};
		scenario.assertions.push({
			id: "external-refs-present",
			kind: "external.refs",
		});

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "missing-external-ref-kinds"),
		).toThrow(
			"missing-external-ref-kinds.assertions[].requiredExternalRefKinds must not be empty for external.refs",
		);
	});

	it("rejects unknown external ref assertion kinds", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.externalRefs = {
			ensembleTranscriptIds: ["slack-contract-lab/dev/thread-redacted-0001"],
		};
		scenario.assertions.push({
			id: "external-refs-present",
			kind: "external.refs",
			requiredExternalRefKinds: ["unknownTraceIds"],
		});

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "unknown-external-ref-kind"),
		).toThrow(
			"unknown-external-ref-kind.assertions[].requiredExternalRefKinds contains unknown external ref kind(s): unknownTraceIds",
		);
	});

	it("rejects malformed required external refs before evaluation", () => {
		const fixturePath = join(fixturesDir, "local-diagnostic-success.json");
		const scenario = JSON.parse(readFileSync(fixturePath, "utf8"));
		scenario.externalRefs = {
			ensembleTranscriptIds: ["slack-contract-lab/dev/thread-redacted-0001"],
		};
		scenario.assertions.push({
			id: "external-refs-present",
			kind: "external.refs",
			requiredExternalRefKinds: ["ensembleTranscriptIds"],
			requiredExternalRefs: "slack-contract-lab/dev/thread-redacted-0001",
		});

		expect(() =>
			validateAgentTrajectoryScenario(scenario, "malformed-external-refs"),
		).toThrow(
			"malformed-external-refs.assertions[].requiredExternalRefs must contain non-empty strings for external.refs",
		);
	});
});
