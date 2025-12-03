import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	QueueController,
	type QueueControllerCallbacks,
	type QueueMode,
} from "../../src/tui/queue/queue-controller.js";

function createMockNotificationView() {
	return {
		showInfo: vi.fn(),
		showToast: vi.fn(),
		showError: vi.fn(),
	};
}

function createMockEditor() {
	return {
		disableSubmit: false,
		setText: vi.fn(),
	};
}

function createMockCallbacks(
	overrides: Partial<QueueControllerCallbacks> = {},
): QueueControllerCallbacks {
	return {
		onModeChange: vi.fn(),
		onQueueCountChange: vi.fn(),
		isAgentRunning: vi.fn().mockReturnValue(false),
		refreshFooterHint: vi.fn(),
		requestRender: vi.fn(),
		persistUiState: vi.fn(),
		...overrides,
	};
}

function createMockPromptQueue() {
	let subscribers: Array<(event: any) => void> = [];
	return {
		subscribe: vi.fn((fn: (event: any) => void) => {
			subscribers.push(fn);
			return () => {
				subscribers = subscribers.filter((s) => s !== fn);
			};
		}),
		cancel: vi.fn().mockReturnValue(true),
		cancelAll: vi.fn(),
		clearActive: vi.fn(),
		getSnapshot: vi.fn().mockReturnValue({ pending: [] }),
		_emit: (event: any) => {
			for (const sub of subscribers) {
				sub(event);
			}
		},
	};
}

describe("QueueController", () => {
	describe("initialization", () => {
		it("defaults to 'all' mode", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});
			expect(controller.getMode()).toBe("all");
			expect(controller.isEnabled()).toBe(true);
		});

		it("uses initialMode when provided", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
				initialMode: "one",
			});
			expect(controller.getMode()).toBe("one");
			expect(controller.isEnabled()).toBe(false);
		});
	});

	describe("attach/detach", () => {
		it("attaches queue and subscribes to events", () => {
			const queue = createMockPromptQueue();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});

			controller.attach(queue as any);

			expect(controller.hasQueue()).toBe(true);
			expect(queue.subscribe).toHaveBeenCalled();
		});

		it("detaches queue and unsubscribes", () => {
			const queue = createMockPromptQueue();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});

			controller.attach(queue as any);
			controller.detach();

			expect(controller.hasQueue()).toBe(false);
		});
	});

	describe("setMode", () => {
		it("sets mode to all and enables queue", () => {
			const callbacks = createMockCallbacks();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView as any,
				editor: createMockEditor() as any,
				callbacks,
				initialMode: "one",
			});

			controller.setMode("all");

			expect(controller.getMode()).toBe("all");
			expect(controller.isEnabled()).toBe(true);
			expect(callbacks.persistUiState).toHaveBeenCalledWith({
				queueMode: "all",
			});
			expect(notificationView.showToast).toHaveBeenCalledWith(
				expect.stringContaining("all"),
				"success",
			);
			expect(callbacks.onModeChange).toHaveBeenCalledWith("all");
		});

		it("sets mode to one and disables queue", () => {
			const callbacks = createMockCallbacks();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks,
				initialMode: "all",
			});

			controller.setMode("one");

			expect(controller.getMode()).toBe("one");
			expect(controller.isEnabled()).toBe(false);
		});

		it("disables submit when agent is running and mode is one", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(true),
			});
			const editor = createMockEditor();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: editor as any,
				callbacks,
				initialMode: "all",
			});

			controller.setMode("one");

			expect(editor.disableSubmit).toBe(true);
		});
	});

	describe("cancel", () => {
		it("returns false when no queue attached", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});

			expect(controller.cancel(1)).toBe(false);
		});

		it("cancels and refreshes hint on success", () => {
			const queue = createMockPromptQueue();
			const callbacks = createMockCallbacks();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks,
			});
			controller.attach(queue as any);

			const result = controller.cancel(1);

			expect(result).toBe(true);
			expect(queue.cancel).toHaveBeenCalledWith(1);
			expect(callbacks.refreshFooterHint).toHaveBeenCalled();
		});
	});

	describe("cancelAll", () => {
		it("cancels all prompts and clears preview", () => {
			const queue = createMockPromptQueue();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			controller.cancelAll();

			expect(queue.cancelAll).toHaveBeenCalled();
			expect(controller.getNextPreview()).toBeNull();
		});
	});

	describe("restoreQueuedPrompts", () => {
		it("does nothing when no queue attached", () => {
			const editor = createMockEditor();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: editor as any,
				callbacks: createMockCallbacks(),
			});

			controller.restoreQueuedPrompts();

			expect(editor.setText).not.toHaveBeenCalled();
		});

		it("restores active and pending prompts to editor", () => {
			const queue = createMockPromptQueue();
			queue.getSnapshot.mockReturnValue({
				active: { id: 1, text: "Active prompt" },
				pending: [
					{ id: 2, text: "Pending 1" },
					{ id: 3, text: "Pending 2" },
				],
			});
			const editor = createMockEditor();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView as any,
				editor: editor as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			controller.restoreQueuedPrompts();

			expect(editor.setText).toHaveBeenCalledWith(
				"Active prompt\n\nPending 1\n\nPending 2",
			);
			expect(queue.cancelAll).toHaveBeenCalledWith({ silent: true });
			expect(queue.clearActive).toHaveBeenCalled();
			expect(notificationView.showToast).toHaveBeenCalledWith(
				"Restored 3 queued prompts to the editor.",
				"info",
			);
		});

		it("does nothing when queue is empty", () => {
			const queue = createMockPromptQueue();
			queue.getSnapshot.mockReturnValue({ pending: [] });
			const editor = createMockEditor();
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: editor as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			controller.restoreQueuedPrompts();

			expect(editor.setText).not.toHaveBeenCalled();
		});
	});

	describe("buildQueueHint", () => {
		it("returns null when agent is running", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(true),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks,
			});

			expect(controller.buildQueueHint()).toBeNull();
		});

		it("returns null when no queued prompts", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView() as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});

			expect(controller.buildQueueHint()).toBeNull();
		});
	});

	describe("event handling", () => {
		it("shows error notification on error event", () => {
			const queue = createMockPromptQueue();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			queue._emit({
				type: "error",
				error: new Error("Test error"),
				entry: { id: 5, text: "test" },
			});

			expect(notificationView.showError).toHaveBeenCalledWith(
				"Prompt #5 failed: Test error",
			);
		});

		it("shows info notification on enqueue when not running immediately", () => {
			const queue = createMockPromptQueue();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			queue._emit({
				type: "enqueue",
				willRunImmediately: false,
				entry: { id: 2, text: "test" },
				pendingCount: 2,
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Queued prompt #2 (2 pending)",
			);
		});

		it("shows info notification on cancel", () => {
			const queue = createMockPromptQueue();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView as any,
				editor: createMockEditor() as any,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as any);

			queue._emit({
				type: "cancel",
				entry: { id: 3, text: "test" },
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Removed queued prompt #3",
			);
		});
	});
});
