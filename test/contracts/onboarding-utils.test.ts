import { describe, expect, it } from "vitest";
import {
	getActiveComposerProjectOnboardingSteps,
	getComposerProjectOnboardingActions,
	getComposerResumableSessions,
	normalizeComposerResumeSummary,
	truncateComposerResumeSummary,
} from "../../packages/contracts/src/onboarding-utils.js";

describe("onboarding utils", () => {
	it("returns only enabled incomplete onboarding steps", () => {
		expect(
			getActiveComposerProjectOnboardingSteps({
				steps: [
					{
						key: "workspace",
						text: "Create a workspace.",
						isComplete: false,
						isEnabled: true,
					},
					{
						key: "instructions",
						text: "Run /init.",
						isComplete: true,
						isEnabled: true,
					},
				],
			}),
		).toEqual([
			expect.objectContaining({
				key: "workspace",
			}),
		]);
	});

	it("builds onboarding actions for workspace and instructions steps", () => {
		expect(
			getComposerProjectOnboardingActions({
				steps: [
					{
						key: "workspace",
						text: "Create a workspace.",
						isComplete: false,
						isEnabled: true,
					},
					{
						key: "instructions",
						text: "Run /init.",
						isComplete: false,
						isEnabled: true,
					},
				],
			}),
		).toEqual([
			expect.objectContaining({
				id: "create-app",
				label: "Create app",
				kind: "prompt",
			}),
			expect.objectContaining({
				id: "clone-repo",
				label: "Clone repo",
				kind: "prompt",
			}),
			expect.objectContaining({
				id: "init",
				label: "Run /init",
				kind: "command",
				value: "/init",
			}),
		]);
	});

	it("filters resumable sessions to non-empty sessions and excludes the active one", () => {
		expect(
			getComposerResumableSessions(
				[
					{
						id: "current",
						messageCount: 0,
					},
					{
						id: "with-summary",
						messageCount: 0,
						resumeSummary: "Continue the refactor.",
					},
					{
						id: "with-messages",
						messageCount: 4,
					},
				],
				{ excludeSessionId: "current" },
			).map((session) => session.id),
		).toEqual(["with-summary", "with-messages"]);
	});

	it("normalizes and truncates resume summaries", () => {
		expect(normalizeComposerResumeSummary("  Continue shipping.  ")).toBe(
			"Continue shipping.",
		);
		expect(normalizeComposerResumeSummary("   ")).toBeNull();
		expect(truncateComposerResumeSummary("abcdefgh", 5)).toBe("abcd…");
	});
});
