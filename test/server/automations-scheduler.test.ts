import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAutomationState = vi.fn(() => ({ automations: [] }));
const saveAutomationState = vi.fn();

let autonomousActionsDisabled = false;

vi.mock("../../src/server/stores/automation-store.js", () => ({
	loadAutomationState,
	saveAutomationState,
}));

vi.mock("../../src/config/feature-flags.js", () => ({
	MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH:
		"platform.kill_switches.maestro.autonomous_actions",
	areAutonomousActionsDisabled: () => autonomousActionsDisabled,
}));

describe("automation scheduler", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.stubEnv("MAESTRO_AUTOMATION_POLL_MS", "25");
		autonomousActionsDisabled = false;
		loadAutomationState.mockClear();
		saveAutomationState.mockClear();
	});

	afterEach(async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		scheduler.stopAutomationScheduler();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("keeps polling after boot when the autonomous actions kill switch is enabled", async () => {
		autonomousActionsDisabled = true;
		const scheduler = await import("../../src/server/automations/scheduler.js");

		scheduler.startAutomationScheduler({} as never);
		expect(loadAutomationState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(25);
		expect(loadAutomationState).not.toHaveBeenCalled();

		autonomousActionsDisabled = false;
		await vi.advanceTimersByTimeAsync(25);

		expect(loadAutomationState).toHaveBeenCalledTimes(1);
	});
});
