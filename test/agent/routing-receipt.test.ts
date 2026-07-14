import { describe, expect, it } from "vitest";
import { resolveAgentProfile } from "../../src/agent/profiles.js";
import {
	createRoutingReceipt,
	resolveAgentProfileSelection,
} from "../../src/agent/routing-receipt.js";
import type { RoutingDecision } from "../../src/services/intelligent-router/types.js";

function decision(): RoutingDecision {
	return {
		decisionId: "decision-42",
		taskType: "coding",
		strategy: "quality",
		selectedModel: { provider: "anthropic", model: "claude-opus-4-6" },
		selectedProfile: resolveAgentProfile("high", "anthropic"),
		fallbackProfiles: [resolveAgentProfile("medium", "anthropic")],
		fallbackChain: [{ provider: "openai", model: "gpt-5.4" }],
		scores: [],
		overrideApplied: false,
		reason: "highest_score",
		createdAt: "2026-07-14T12:00:00.000Z",
		oracleConsultation: {
			policyVersion: "evalops.maestro.oracle-consultation.v1",
			evalSuite: "oracle-consultation-policy-v1",
			mode: "recommended",
			reasons: ["high_profile"],
		},
	};
}

describe("resolveAgentProfileSelection", () => {
	it("prefers an explicit request over the session pin and compatibility default", () => {
		expect(
			resolveAgentProfileSelection({
				requestedProfile: "high",
				sessionPin: { profile: "medium", updatedAt: "2026-07-14T11:00:00Z" },
				compatibilityProfile: "low",
			}),
		).toEqual({ requestedProfile: "high", source: "request" });
	});

	it("uses the session pin before the compatibility default", () => {
		expect(
			resolveAgentProfileSelection({
				sessionPin: { profile: "medium", updatedAt: "2026-07-14T11:00:00Z" },
				compatibilityProfile: "low",
			}),
		).toEqual({ requestedProfile: "medium", source: "session" });
	});

	it("falls back to the compatibility profile", () => {
		expect(
			resolveAgentProfileSelection({ compatibilityProfile: "low" }),
		).toEqual({ requestedProfile: "low", source: "compatibility_default" });
	});
});

describe("createRoutingReceipt", () => {
	it("projects an immutable routing receipt with Oracle, fallback, and experiment detail", () => {
		const receipt = createRoutingReceipt(decision(), {
			requestedProfile: "high",
			source: "session",
			fallbackReason: "primary_unavailable",
			experiment: {
				experimentId: "oracle-policy-2026-07",
				arm: "treatment",
				policyVersion: "oracle-v2",
			},
		});

		expect(receipt).toMatchObject({
			decisionId: "decision-42",
			requestedProfile: "high",
			source: "session",
			resolvedProfileId: "high-v1",
			resolvedProfileVersion: 1,
			provider: "anthropic",
			model: "claude-opus-4-6",
			reasoningEffort: "xhigh",
			createdAt: "2026-07-14T12:00:00.000Z",
			oracle: {
				policyVersion: "evalops.maestro.oracle-consultation.v1",
				mode: "recommended",
				reasons: ["high_profile"],
			},
			fallback: { reason: "primary_unavailable" },
			experiment: {
				experimentId: "oracle-policy-2026-07",
				arm: "treatment",
				policyVersion: "oracle-v2",
			},
		});
		expect(Object.isFrozen(receipt)).toBe(true);
		expect(Object.isFrozen(receipt.oracle)).toBe(true);
		expect(Object.isFrozen(receipt.experiment)).toBe(true);
	});
});
