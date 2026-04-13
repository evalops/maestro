import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultApprovalMode } from "../../src/config/default-approval-mode.js";
import * as featureFlags from "../../src/config/feature-flags.js";

describe("resolveDefaultApprovalMode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("defaults hosted profiles to fail when the flag is disabled", () => {
		vi.spyOn(featureFlags, "isDraftAndConfirmDefaultEnabled").mockReturnValue(
			false,
		);

		expect(resolveDefaultApprovalMode({ profile: "production" })).toBe("fail");
	});

	it("forces draft-and-confirm mode when the flag is enabled", () => {
		vi.spyOn(featureFlags, "isDraftAndConfirmDefaultEnabled").mockReturnValue(
			true,
		);

		expect(resolveDefaultApprovalMode({ profile: "production" })).toBe(
			"prompt",
		);
	});

	it("preserves explicit approval mode overrides", () => {
		vi.spyOn(featureFlags, "isDraftAndConfirmDefaultEnabled").mockReturnValue(
			true,
		);

		expect(
			resolveDefaultApprovalMode({
				profile: "production",
				explicitApprovalMode: "fail",
			}),
		).toBe("fail");
		expect(
			resolveDefaultApprovalMode({
				profile: "production",
				explicitApprovalMode: "auto",
			}),
		).toBe("auto");
	});
});
