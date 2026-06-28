import { describe, expect, it } from "vitest";
import { buildSwarmOrchestratorPrompt } from "../../src/agent/swarm/orchestrator-prompt.js";

describe("buildSwarmOrchestratorPrompt", () => {
	it("frames the orchestrator as architect, not builder", () => {
		const prompt = buildSwarmOrchestratorPrompt();
		expect(prompt).toContain("architect and orchestrator");
		expect(prompt).toContain("You do not build directly");
	});

	it("requires requirement capture, echo-back, and no silent substitution", () => {
		const prompt = buildSwarmOrchestratorPrompt();
		expect(prompt).toContain("Requirement Tracking");
		expect(prompt).toContain("Echo back");
		expect(prompt).toContain("Do not silently substitute");
	});

	it("makes end-to-end validation the default and references the coverage gate", () => {
		const prompt = buildSwarmOrchestratorPrompt();
		expect(prompt).toContain("End-to-End Validation Is the Default");
		expect(prompt).toContain("Mocks and stubs are a conscious opt-out");
		expect(prompt).toContain("coverage gate refuses to start work");
	});

	it("swaps in the mocks-permitted posture only on explicit opt-out", () => {
		const prompt = buildSwarmOrchestratorPrompt({ mocksAllowed: true });
		expect(prompt).toContain("Validation Posture: Mocks Permitted");
		expect(prompt).not.toContain("End-to-End Validation Is the Default");
	});
});
