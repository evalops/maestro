import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PromptQueue,
	PromptQueueEvent,
} from "../../src/cli-tui/prompt-queue.js";
import {
	QueueController,
	type QueueControllerCallbacks,
	type QueueControllerOptions,
} from "../../src/cli-tui/queue/queue-controller.js";

function createMockNotificationView(): QueueControllerOptions["notificationView"] {
	return {
		showInfo: vi.fn(),
		showToast: vi.fn(),
		showError: vi.fn(),
	} as unknown as QueueControllerOptions["notificationView"];
}

function createMockEditor(): QueueControllerOptions["editor"] {
	return {
		disableSubmit: false,
		setText: vi.fn(),
		getText: vi.fn().mockReturnValue(""),
		focus: vi.fn(),
		blur: vi.fn(),
		setPlaceholder: vi.fn(),
		setDisabled: vi.fn(),
		getHeight: vi.fn().mockReturnValue(1),
		onSubmit: vi.fn(),
		render: vi.fn().mockReturnValue(""),
		handleInput: vi.fn().mockReturnValue(false),
		handleMouse: vi.fn().mockReturnValue(false),
	} as unknown as QueueControllerOptions["editor"];
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

interface MockPromptQueue {
	subscribe: ReturnType<typeof vi.fn>;
	cancel: ReturnType<typeof vi.fn>;
	cancelAll: ReturnType<typeof vi.fn>;
	clearActive: ReturnType<typeof vi.fn>;
	getSnapshot: ReturnType<typeof vi.fn>;
	_emit: (event: PromptQueueEvent) => void;
}

function createMockPromptQueue(): MockPromptQueue {
	let subscribers: Array<(event: PromptQueueEvent) => void> = [];
	return {
		subscribe: vi.fn((fn: (event: PromptQueueEvent) => void) => {
			subscribers.push(fn);
			return () => {
				subscribers = subscribers.filter((s) => s !== fn);
			};
		}),
		cancel: vi.fn().mockReturnValue(true),
		cancelAll: vi.fn(),
		clearActive: vi.fn(),
		getSnapshot: vi.fn().mockReturnValue({ pending: [] }),
		_emit: (event: PromptQueueEvent) => {
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
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});
			expect(controller.getSteeringMode()).toBe("all");
			expect(controller.getFollowUpMode()).toBe("all");
			expect(controller.isFollowUpEnabled()).toBe(true);
			expect(controller.isSteeringEnabled()).toBe(true);
		});

		it("uses initial modes when provided", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
				initialSteeringMode: "one",
				initialFollowUpMode: "one",
			});
			expect(controller.getSteeringMode()).toBe("one");
			expect(controller.getFollowUpMode()).toBe("one");
			expect(controller.isFollowUpEnabled()).toBe(false);
			expect(controller.isSteeringEnabled()).toBe(false);
		});
	});

	describe("attach/detach", () => {
		it("attaches queue and subscribes to events", () => {
			const queue = createMockPromptQueue();
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});

			controller.attach(queue as unknown as PromptQueue);

			expect(controller.hasQueue()).toBe(true);
			expect(queue.subscribe).toHaveBeenCalled();
		});

		it("detaches queue and unsubscribes", () => {
			const queue = createMockPromptQueue();
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});

			controller.attach(queue as unknown as PromptQueue);
			controller.detach();

			expect(controller.hasQueue()).toBe(false);
		});
	});

	describe("setMode", () => {
		it("sets follow-up mode to all and enables follow-ups", () => {
			const callbacks = createMockCallbacks();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView,
				editor: createMockEditor(),
				callbacks,
				initialFollowUpMode: "one",
			});

			controller.setMode("followUp", "all");

			expect(controller.getFollowUpMode()).toBe("all");
			expect(controller.isFollowUpEnabled()).toBe(true);
			expect(callbacks.persistUiState).toHaveBeenCalledWith({
				steeringMode: "all",
				followUpMode: "all",
			});
			expect(notificationView.showToast).toHaveBeenCalledWith(
				expect.stringContaining("all"),
				"success",
			);
			expect(callbacks.onModeChange).toHaveBeenCalledWith("followUp", "all");
		});

		it("sets steering mode to one", () => {
			const callbacks = createMockCallbacks();
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
				initialSteeringMode: "all",
			});

			controller.setMode("steering", "one");

			expect(controller.getSteeringMode()).toBe("one");
		});
	});

	describe("cancel", () => {
		it("returns false when no queue attached", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});

			expect(controller.cancel(1)).toBe(false);
		});

		it("cancels and refreshes hint on success", () => {
			const queue = createMockPromptQueue();
			const callbacks = createMockCallbacks();
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.attach(queue as unknown as PromptQueue);

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
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

			controller.cancelAll();

			expect(queue.cancelAll).toHaveBeenCalled();
			expect(controller.getNextPreview()).toBeNull();
		});
	});

	describe("restoreQueuedPrompts", () => {
		it("does nothing when no queue attached", () => {
			const editor = createMockEditor();
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: editor,
				callbacks: createMockCallbacks(),
			});

			controller.restoreQueuedPrompts();

			expect(editor.setText).not.toHaveBeenCalled();
		});

		it("restores active and pending prompts to editor", () => {
			const queue = createMockPromptQueue();
			queue.getSnapshot.mockReturnValue({
				active: { id: 1, text: "Active prompt", kind: "prompt" },
				pending: [
					{ id: 2, text: "Pending 1", kind: "prompt" },
					{ id: 3, text: "Pending 2", kind: "prompt" },
				],
			});
			const editor = createMockEditor();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView,
				editor: editor,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

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
				notificationView: createMockNotificationView(),
				editor: editor,
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

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
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});

			expect(controller.buildQueueHint()).toBeNull();
		});

		it("returns null when no queued prompts", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
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
				notificationView: notificationView,
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

			queue._emit({
				type: "error",
				error: new Error("Test error"),
				entry: {
					id: 5,
					text: "test",
					createdAt: Date.now(),
					kind: "prompt",
				},
			});

			expect(notificationView.showError).toHaveBeenCalledWith(
				"Prompt #5 failed: Test error",
			);
		});

		it("shows info notification on enqueue when not running immediately", () => {
			const queue = createMockPromptQueue();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView,
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

			queue._emit({
				type: "enqueue",
				willRunImmediately: false,
				entry: {
					id: 2,
					text: "test",
					createdAt: Date.now(),
					kind: "followUp",
				},
				pendingCount: 2,
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Queued follow-up #2 (2 pending)",
			);
		});

		it("shows info notification on cancel", () => {
			const queue = createMockPromptQueue();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView: notificationView,
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});
			controller.attach(queue as unknown as PromptQueue);

			queue._emit({
				type: "cancel",
				entry: {
					id: 3,
					text: "test",
					createdAt: Date.now(),
					kind: "prompt",
				},
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Removed queued prompt #3",
			);
		});
	});
});
