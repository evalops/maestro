import { describe, expect, it } from "vitest";
import {
	ORACLE_CONSULTATION_POLICY_VERSION,
	applyOracleConsultationDirective,
	formatOracleConsultationDirective,
	recommendOracleConsultation,
} from "../../src/agent/oracle-consultation-policy.js";
import type { AgentProfileLevel } from "../../src/agent/profiles.js";

const evalCases: Array<{
	name: string;
	profileLevel: AgentProfileLevel;
	taskType: string;
	taskSummary?: string;
	priorFailures?: number;
	expected: "available" | "recommended" | "required";
}> = [
	{
		name: "low-risk edit avoids mandatory spend",
		profileLevel: "low",
		taskType: "coding",
		taskSummary: "Rename a local variable",
		expected: "available",
	},
	{
		name: "medium ordinary work keeps oracle available",
		profileLevel: "medium",
		taskType: "coding",
		taskSummary: "Add a bounded parser test",
		expected: "available",
	},
	{
		name: "architecture gets independent review",
		profileLevel: "medium",
		taskType: "architecture",
		taskSummary: "Choose a durable event model",
		expected: "recommended",
	},
	{
		name: "ambiguity triggers consultation",
		profileLevel: "medium",
		taskType: "coding",
		taskSummary: "Requirements are ambiguous with several tradeoffs",
		expected: "recommended",
	},
	{
		name: "migration cues in ordinary chat trigger consultation",
		profileLevel: "medium",
		taskType: "chat",
		taskSummary: "Migrate the session store to the new schema",
		expected: "recommended",
	},
	{
		name: "security cues in ordinary chat trigger consultation",
		profileLevel: "medium",
		taskType: "chat",
		taskSummary: "Review authentication boundaries for this endpoint",
		expected: "recommended",
	},
	{
		name: "architecture cues in ordinary chat trigger consultation",
		profileLevel: "medium",
		taskType: "chat",
		taskSummary: "Redesign the event architecture across services",
		expected: "recommended",
	},
	{
		name: "high profile consults by default",
		profileLevel: "high",
		taskType: "coding",
		taskSummary: "Change routing behavior across packages",
		expected: "recommended",
	},
	{
		name: "ultra profile requires consultation",
		profileLevel: "ultra",
		taskType: "migration",
		taskSummary: "Migrate persisted sessions without data loss",
		expected: "required",
	},
	{
		name: "repeated failures escalate medium work",
		profileLevel: "medium",
		taskType: "debugging",
		priorFailures: 2,
		expected: "required",
	},
	{
		name: "low profile caps repeated-failure escalation",
		profileLevel: "low",
		taskType: "debugging",
		priorFailures: 2,
		expected: "recommended",
	},
];

describe("oracle consultation policy eval matrix", () => {
	for (const evalCase of evalCases) {
		it(evalCase.name, () => {
			const decision = recommendOracleConsultation(evalCase);
			expect(decision.mode).toBe(evalCase.expected);
			expect(decision.policyVersion).toBe(ORACLE_CONSULTATION_POLICY_VERSION);
			expect(decision.evalSuite).toBe("oracle-consultation-policy-v1");
		});
	}

	it("formats an explicit, read-only required directive", () => {
		const directive = formatOracleConsultationDirective(
			recommendOracleConsultation({
				profileLevel: "ultra",
				taskType: "architecture",
			}),
		);

		expect(directive).toContain("MUST consult the read-only Oracle once");
		expect(directive).toContain(ORACLE_CONSULTATION_POLICY_VERSION);
	});

	it("projects the assigned experiment policy version", () => {
		expect(
			recommendOracleConsultation({
				profileLevel: "high",
				taskType: "coding",
				policyVersion: "oracle-v2",
			}).policyVersion,
		).toBe("oracle-v2");
	});

	it("queues recommended guidance exactly once for the next run", () => {
		const additions: string[] = [];
		const queued = applyOracleConsultationDirective(
			{ queueNextRunSystemPromptAddition: (text) => additions.push(text) },
			recommendOracleConsultation({
				profileLevel: "high",
				taskType: "coding",
			}),
		);

		expect(queued).toBe(true);
		expect(additions).toHaveLength(1);
		expect(additions[0]).toContain("read-only Oracle once");
	});
});
