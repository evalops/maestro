import { describe, expect, it } from "vitest";
import {
	buildSafetyApprovalsViewModel,
	formatGuardianDuration,
	formatGuardianTimestamp,
} from "../../packages/desktop/src/renderer/components/Settings/SafetyApprovalsSection";

describe("formatGuardianTimestamp", () => {
	it("returns unknown when the timestamp is missing or invalid", () => {
		expect(formatGuardianTimestamp()).toBe("Unknown");
		expect(formatGuardianTimestamp("not-a-date")).toBe("Unknown");
	});

	it("formats valid timestamps", () => {
		const startedAt = 1_700_000_000_000;

		expect(formatGuardianTimestamp(startedAt)).toBe(
			new Date(startedAt).toLocaleString(),
		);
	});
});

describe("formatGuardianDuration", () => {
	it("formats empty, millisecond, and second durations", () => {
		expect(formatGuardianDuration()).toBe("");
		expect(formatGuardianDuration(250)).toBe("250ms");
		expect(formatGuardianDuration(1_500)).toBe("1.5s");
		expect(formatGuardianDuration(90_000)).toBe("90s");
	});
});

describe("buildSafetyApprovalsViewModel", () => {
	it("summarizes guardian state and the latest run", () => {
		const startedAt = 1_700_000_000_000;
		const viewModel = buildSafetyApprovalsViewModel(
			"prompt",
			{
				enabled: true,
				state: {
					enabled: true,
					lastRun: {
						status: "passed",
						startedAt,
						durationMs: 1_500,
						filesScanned: 42,
						summary: "No secrets found",
					},
				},
			},
			true,
		);

		expect(viewModel.approvalMode).toBe("prompt");
		expect(viewModel.guardianChecked).toBe(true);
		expect(viewModel.guardianEnabledLabel).toBe("On");
		expect(viewModel.guardianActionLabel).toBe("Running…");
		expect(viewModel.guardianActionDisabled).toBe(true);
		expect(viewModel.lastRun).toEqual({
			status: "passed",
			summary: "No secrets found",
			durationLabel: "1.5s",
			timestampLabel: new Date(startedAt).toLocaleString(),
		});
	});

	it("preserves the current guardian fallback behavior when status is missing", () => {
		const viewModel = buildSafetyApprovalsViewModel("auto", null, false);

		expect(viewModel.approvalMode).toBe("auto");
		expect(viewModel.guardianChecked).toBe(true);
		expect(viewModel.guardianEnabledLabel).toBe("Off");
		expect(viewModel.guardianActionLabel).toBe("Run now");
		expect(viewModel.guardianActionDisabled).toBe(false);
		expect(viewModel.lastRun).toBeNull();
	});
});
