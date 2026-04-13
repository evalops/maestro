import { afterEach, describe, expect, it, vi } from "vitest";
import * as featureFlags from "../../src/config/feature-flags.js";
import {
	startAutomationScheduler,
	stopAutomationScheduler,
} from "../../src/server/automations/scheduler.js";

describe("startAutomationScheduler", () => {
	afterEach(() => {
		stopAutomationScheduler();
		vi.restoreAllMocks();
	});

	it("does not start when autonomous actions are disabled", () => {
		vi.spyOn(featureFlags, "areAutonomousActionsDisabled").mockReturnValue(
			true,
		);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

		startAutomationScheduler({} as never);

		expect(setIntervalSpy).not.toHaveBeenCalled();
	});
});
