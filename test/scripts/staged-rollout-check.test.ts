import { describe, expect, it } from "vitest";
import {
	defaultDiffBase,
	evaluateStagedRolloutCheck,
	hasStagedRolloutAnswer,
	isRiskySurfacePath,
	validateRegistry,
} from "../../scripts/check-staged-rollout.mjs";

const validRegistry = {
	version: 1,
	surfaces: [
		{
			id: "mode:frontier",
			type: "hidden_mode",
			owner: "agent-runtime",
			introduced_in: "2026-05-09",
			status: "experimental",
			target: "promote-or-remove",
			telemetry_event: "hidden_mode_used",
			rationale: "Exercises a hidden mode before broad exposure.",
		},
	],
};

describe("staged rollout check", () => {
	it("detects risky staged-rollout surfaces", () => {
		expect(isRiskySurfacePath("src/agent/modes.ts")).toBe(true);
		expect(isRiskySurfacePath("proto/maestro/v1/headless.proto")).toBe(true);
		expect(isRiskySurfacePath("docs/CONVENTIONS/staged-rollout.md")).toBe(
			false,
		);
	});

	it("accepts explicit staged-rollout PR body answers", () => {
		expect(
			hasStagedRolloutAnswer(
				"Staged-rollout choice: this lands as an enabling primitive.",
			),
		).toBe(true);
		expect(hasStagedRolloutAnswer("Small typo fix.")).toBe(false);
		expect(
			hasStagedRolloutAnswer(
				"- [ ] If this PR adds or promotes user-visible behavior, explain the staged-rollout choice (or why staging is unnecessary).",
			),
		).toBe(false);
	});

	it("derives a pull request diff base when CI omits explicit base env", () => {
		expect(defaultDiffBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
		expect(defaultDiffBase({ GITHUB_REF_NAME: "feature/test" })).toBe(
			"origin/main",
		);
		expect(defaultDiffBase({ GITHUB_REF_NAME: "main" })).toBe("");
	});

	it("validates registry ownership and telemetry", () => {
		expect(validateRegistry(validRegistry)).toEqual([]);
		expect(
			validateRegistry({
				version: 1,
				surfaces: [
					{
						id: "mode:frontier",
						type: "hidden_model",
						owner: "agent-runtime",
						introduced_in: "2026-05-09",
						status: "experimental",
						target: "promote-or-remove",
						rationale: "Typoed rollout surface type should fail.",
					},
				],
			}),
		).toContain("mode:frontier: unknown type hidden_model");
		expect(
			validateRegistry({
				version: 1,
				surfaces: [
					{
						id: "mode:frontier",
						type: "hidden_mode",
						owner: "agent-runtime",
						introduced_in: "2026-05-09",
						status: "experimental",
						target: "promote-or-remove",
						rationale: "Missing telemetry should fail.",
					},
				],
			}),
		).toContain(
			"mode:frontier: hidden/internal surfaces require telemetry_event",
		);
		expect(
			validateRegistry({
				version: 1,
				surfaces: [
					{
						id: "protocol:hello-ok-server-capabilities",
						type: "protocol_capability",
						owner: "headless-runtime",
						introduced_in: "2026-05-09",
						status: "enabling-primitive",
						target: "use-for-next-protocol-ui-promotion",
						rationale:
							"Protocol capability metadata is negotiated before UI promotion.",
					},
				],
			}),
		).toEqual([]);
		expect(
			validateRegistry({
				version: 1,
				surfaces: [
					{
						id: "mode:frontier",
						type: "hidden_mode",
						owner: "agent-runtime",
						introduced_in: "05/09/2026",
						status: "beta",
						target: "promote-or-remove",
						telemetry_event: "hidden_mode_used",
						rationale: "Bad taxonomy should fail closed.",
					},
				],
			}),
		).toEqual(
			expect.arrayContaining([
				"mode:frontier: introduced_in must be YYYY-MM-DD",
				"mode:frontier: unknown status beta",
			]),
		);
	});

	it("requires a PR body answer when risky files change", () => {
		expect(
			evaluateStagedRolloutCheck({
				registry: validRegistry,
				changedFiles: ["src/cli/args.ts"],
				prBody: "",
				isPullRequest: true,
			}).failures,
		).toEqual([
			"risky staged-rollout surfaces changed without a staged-rollout PR-body answer: src/cli/args.ts",
		]);

		expect(
			evaluateStagedRolloutCheck({
				registry: validRegistry,
				changedFiles: ["src/cli/args.ts"],
				prBody: "Staged rollout choice: hidden flag with telemetry.",
				isPullRequest: true,
			}).failures,
		).toEqual([]);
	});
});
