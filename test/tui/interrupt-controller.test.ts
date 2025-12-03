import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type InterruptCallbacks,
	InterruptController,
} from "../../src/tui/interrupt-controller.js";

// Mock footer and notification view
function createMockFooter() {
	return {
		setHint: vi.fn(),
	};
}

function createMockNotificationView() {
	return {
		showInfo: vi.fn(),
		showToast: vi.fn(),
	};
}

function createMockCallbacks(
	overrides: Partial<InterruptCallbacks> = {},
): InterruptCallbacks {
	return {
		onInterrupt: vi.fn(),
		restoreQueuedPrompts: vi.fn(),
		getWorkingHint: vi.fn().mockReturnValue("Working…"),
		isMinimalMode: vi.fn().mockReturnValue(false),
		isAgentRunning: vi.fn().mockReturnValue(true),
		refreshFooterHint: vi.fn(),
		...overrides,
	};
}

describe("InterruptController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("isArmed", () => {
		it("returns false initially", () => {
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: createMockNotificationView() as any,
				callbacks: createMockCallbacks(),
			});
			expect(controller.isArmed()).toBe(false);
		});
	});

	describe("handleInterruptRequest", () => {
		it("does nothing when agent is not running and not armed", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(false),
			});
			const footer = createMockFooter();
			const controller = new InterruptController({
				footer: footer as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			controller.handleInterruptRequest();

			expect(footer.setHint).not.toHaveBeenCalled();
			expect(controller.isArmed()).toBe(false);
		});

		it("arms on first press when agent is running", () => {
			const callbacks = createMockCallbacks();
			const footer = createMockFooter();
			const notificationView = createMockNotificationView();
			const controller = new InterruptController({
				footer: footer as any,
				notificationView: notificationView as any,
				callbacks,
			});

			controller.handleInterruptRequest();

			expect(controller.isArmed()).toBe(true);
			expect(footer.setHint).toHaveBeenCalledWith(
				"Esc=discard | K=keep partial",
			);
			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Press Esc to discard, K to keep partial response",
			);
		});

		it("does not show info when in minimal mode", () => {
			const callbacks = createMockCallbacks({
				isMinimalMode: vi.fn().mockReturnValue(true),
			});
			const notificationView = createMockNotificationView();
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: notificationView as any,
				callbacks,
			});

			controller.handleInterruptRequest();

			expect(notificationView.showInfo).not.toHaveBeenCalled();
		});

		it("executes discard on second press", () => {
			const callbacks = createMockCallbacks();
			const notificationView = createMockNotificationView();
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: notificationView as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm
			controller.handleInterruptRequest(); // execute

			expect(controller.isArmed()).toBe(false);
			expect(callbacks.onInterrupt).toHaveBeenCalledWith({
				keepPartial: false,
			});
			expect(callbacks.restoreQueuedPrompts).toHaveBeenCalled();
			expect(notificationView.showToast).toHaveBeenCalledWith(
				"Interrupted current run",
				"warn",
			);
		});
	});

	describe("handleKeepPartialRequest", () => {
		it("returns false when not armed", () => {
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: createMockNotificationView() as any,
				callbacks: createMockCallbacks(),
			});

			expect(controller.handleKeepPartialRequest()).toBe(false);
		});

		it("executes with keepPartial true when armed", () => {
			const callbacks = createMockCallbacks();
			const notificationView = createMockNotificationView();
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: notificationView as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm
			const result = controller.handleKeepPartialRequest();

			expect(result).toBe(true);
			expect(controller.isArmed()).toBe(false);
			expect(callbacks.onInterrupt).toHaveBeenCalledWith({ keepPartial: true });
			expect(notificationView.showToast).toHaveBeenCalledWith(
				"Interrupted - keeping partial response",
				"info",
			);
		});
	});

	describe("clear", () => {
		it("clears armed state", () => {
			const callbacks = createMockCallbacks();
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm
			expect(controller.isArmed()).toBe(true);

			controller.clear();
			expect(controller.isArmed()).toBe(false);
		});

		it("restores working hint when agent is running", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(true),
				getWorkingHint: vi.fn().mockReturnValue("Working..."),
			});
			const footer = createMockFooter();
			const controller = new InterruptController({
				footer: footer as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm
			footer.setHint.mockClear();

			controller.clear();

			expect(footer.setHint).toHaveBeenCalledWith("Working...");
		});

		it("calls refreshFooterHint when agent is not running", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(false),
			});
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			// Force arm state
			(callbacks.isAgentRunning as any).mockReturnValue(true);
			controller.handleInterruptRequest();
			(callbacks.isAgentRunning as any).mockReturnValue(false);

			controller.clear();

			expect(callbacks.refreshFooterHint).toHaveBeenCalled();
		});
	});

	describe("timeout behavior", () => {
		it("auto-clears after 5 seconds", () => {
			const callbacks = createMockCallbacks();
			const controller = new InterruptController({
				footer: createMockFooter() as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm
			expect(controller.isArmed()).toBe(true);

			vi.advanceTimersByTime(5000);

			expect(controller.isArmed()).toBe(false);
		});

		it("clears timeout when manually cleared", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(true),
			});
			const footer = createMockFooter();
			const controller = new InterruptController({
				footer: footer as any,
				notificationView: createMockNotificationView() as any,
				callbacks,
			});

			controller.handleInterruptRequest(); // arm

			// Clear the footer.setHint mock after arming
			footer.setHint.mockClear();

			controller.clear();

			// Verify that clear restored the working hint
			expect(footer.setHint).toHaveBeenCalledWith("Working…");

			// Advance time past original timeout
			vi.advanceTimersByTime(10000);

			// Should not have any additional calls after timeout would have fired
			expect(footer.setHint).toHaveBeenCalledTimes(1);
		});
	});
});

// Need afterEach at module level for timer cleanup
import { afterEach } from "vitest";
