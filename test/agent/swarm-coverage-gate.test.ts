import { describe, expect, it } from "vitest";
import { evaluateSwarmCoverageGate } from "../../src/agent/swarm/coverage-gate.js";
import {
	type ValidationContract,
	createEmptyContract,
} from "../../src/agent/validation-contract.js";

function contractWith(assertionIds: string[]): ValidationContract {
	const contract = createEmptyContract({ id: "c1", surface: "api" });
	contract.areas.push({
		name: "core",
		assertions: assertionIds.map((id) => ({
			id,
			description: id,
			status: "pending" as const,
		})),
	});
	return contract;
}

describe("evaluateSwarmCoverageGate", () => {
	it("passes unconditionally when no contract is configured", () => {
		expect(evaluateSwarmCoverageGate({}).ok).toBe(true);
		expect(evaluateSwarmCoverageGate({ featureClaims: [] }).ok).toBe(true);
	});

	it("passes when every assertion is claimed exactly once", () => {
		const result = evaluateSwarmCoverageGate({
			validationContract: contractWith(["a1", "a2"]),
			featureClaims: [
				{ id: "f1", fulfills: ["a1"] },
				{ id: "f2", fulfills: ["a2"] },
			],
		});
		expect(result.ok).toBe(true);
		expect(result.message).toBeUndefined();
	});

	it("blocks and explains when an assertion is unclaimed", () => {
		const result = evaluateSwarmCoverageGate({
			validationContract: contractWith(["a1", "a2"]),
			featureClaims: [{ id: "f1", fulfills: ["a1"] }],
		});
		expect(result.ok).toBe(false);
		expect(result.report?.orphans).toEqual(["a2"]);
		expect(result.message).toContain("Unclaimed assertions");
		expect(result.message).toContain("a2");
	});

	it("blocks when a feature references an unknown assertion", () => {
		const result = evaluateSwarmCoverageGate({
			validationContract: contractWith(["a1"]),
			featureClaims: [
				{ id: "f1", fulfills: ["a1"] },
				{ id: "f2", fulfills: ["ghost"] },
			],
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("absent from the contract");
		expect(result.message).toContain("ghost");
	});
});
