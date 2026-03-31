import { describe, expect, it, vi } from "vitest";
import type { AppMessage, QueuedMessage } from "../../src/agent/types.js";
import type { QueuedPrompt } from "../../src/cli-tui/prompt-queue.js";
import {
	QueueController,
	type QueueControllerCallbacks,
	type QueueControllerOptions,
} from "../../src/cli-tui/queue/queue-controller.js";
import { getQueuedFollowUpEditBindingLabel } from "../../src/cli-tui/queue/queued-follow-up-edit-binding.js";

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

function createQueuedMessage(
	id: number,
	text: string,
	createdAt: number,
): QueuedMessage<AppMessage> {
	return {
		id,
		createdAt,
		llm: {
			role: "user",
			content: text,
		},
		original: {
			role: "user",
			content: text,
			timestamp: createdAt,
		},
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
		getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
			steering: [],
			followUps: [],
		}),
		cancelQueuedMessage: vi.fn().mockReturnValue(null),
		clearQueuedMessages: vi.fn().mockReturnValue([]),
		prependQueuedFollowUp: vi.fn(async () => {}),
		...overrides,
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
			expect(controller.hasQueue()).toBe(true);
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

	describe("agent sync", () => {
		it("hydrates queued steers and follow-ups from the agent snapshot", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [createQueuedMessage(2, "steer", 20)],
					followUps: [createQueuedMessage(3, "follow", 30)],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});

			controller.syncFromAgent();

			expect(controller.getQueuedSteeringCount()).toBe(1);
			expect(controller.getQueuedFollowUpCount()).toBe(1);
			expect(controller.getNextPreview()).toBe("steer: steer");
			expect(callbacks.onQueueCountChange).toHaveBeenCalledWith(2);
			expect(callbacks.requestRender).toHaveBeenCalled();
		});

		it("builds an inline preview grouped by steering and follow-ups", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [
						createQueuedMessage(1, "steer first", 10),
						createQueuedMessage(2, "steer second", 20),
					],
					followUps: [createQueuedMessage(3, "follow later", 30)],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});

			controller.syncFromAgent();

			expect(controller.buildInlinePreview()).toBe(
				[
					"Queued steering after next tool boundary (next batch: all 2)",
					"  ↳ steer first",
					"  ↳ steer second",
					"  Esc interrupt and apply now",
					"",
					"Queued follow-ups after turn end",
					"  ↳ follow later",
					`  ${getQueuedFollowUpEditBindingLabel()} edit queued follow-ups`,
				].join("\n"),
			);
		});

		it("describes one-at-a-time batches when multiple prompts are queued", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [
						createQueuedMessage(1, "steer first", 10),
						createQueuedMessage(2, "steer second", 20),
					],
					followUps: [
						createQueuedMessage(3, "follow first", 30),
						createQueuedMessage(4, "follow second", 40),
						createQueuedMessage(5, "follow third", 50),
					],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
				initialSteeringMode: "one",
				initialFollowUpMode: "one",
			});

			controller.syncFromAgent();

			expect(controller.getNextSteeringBatchSummary()).toBe(
				"1 of 2 messages at the next tool boundary",
			);
			expect(controller.getNextFollowUpBatchSummary()).toBe(
				"1 of 3 messages after turn end",
			);
			expect(controller.buildInlinePreview()).toContain(
				"Queued steering after next tool boundary (next batch: 1 of 2)",
			);
			expect(controller.buildInlinePreview()).toContain(
				"Esc interrupt and apply now",
			);
			expect(controller.buildInlinePreview()).toContain(
				"Queued follow-ups after turn end (next batch: 1 of 3)",
			);
		});

		it("attach triggers an initial sync", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [createQueuedMessage(1, "queued", 10)],
					followUps: [],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});

			controller.attach({} as never);

			expect(controller.getQueuedCount()).toBe(1);
		});
	});

	describe("setMode", () => {
		it("persists and announces mode changes", () => {
			const callbacks = createMockCallbacks();
			const notificationView = createMockNotificationView();
			const controller = new QueueController({
				notificationView,
				editor: createMockEditor(),
				callbacks,
				initialFollowUpMode: "one",
			});

			controller.setMode("followUp", "all");

			expect(controller.getFollowUpMode()).toBe("all");
			expect(callbacks.persistUiState).toHaveBeenCalledWith({
				steeringMode: "all",
				followUpMode: "all",
			});
			expect(callbacks.onModeChange).toHaveBeenCalledWith("followUp", "all");
			expect(notificationView.showToast).toHaveBeenCalledWith(
				expect.stringContaining("all"),
				"success",
			);
		});
	});

	describe("cancel", () => {
		it("returns false when no queued message exists", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});

			expect(controller.cancel(1)).toBe(false);
		});

		it("removes the queued message and refreshes hints on success", () => {
			let snapshot = {
				steering: [createQueuedMessage(1, "steer", 10)],
				followUps: [createQueuedMessage(2, "follow", 20)],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				cancelQueuedMessage: vi.fn((id: number) => {
					const steering = snapshot.steering.find((entry) => entry.id === id);
					if (steering) {
						snapshot = {
							...snapshot,
							steering: snapshot.steering.filter((entry) => entry.id !== id),
						};
						return steering;
					}
					return null;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			const result = controller.cancel(1);

			expect(result).toBe(true);
			expect(controller.getQueuedSteeringCount()).toBe(0);
			expect(controller.getQueuedFollowUpCount()).toBe(1);
			expect(callbacks.refreshFooterHint).toHaveBeenCalled();
		});
	});

	describe("cancelAll", () => {
		it("clears every queued message and resets the preview", () => {
			let snapshot = {
				steering: [createQueuedMessage(1, "steer", 10)],
				followUps: [createQueuedMessage(2, "follow", 20)],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				clearQueuedMessages: vi.fn(() => {
					const cleared = [...snapshot.steering, ...snapshot.followUps];
					snapshot = { steering: [], followUps: [] };
					return cleared;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			controller.cancelAll({ silent: true });

			expect(controller.getQueuedCount()).toBe(0);
			expect(controller.getNextPreview()).toBeNull();
			expect(callbacks.clearQueuedMessages).toHaveBeenCalled();
		});
	});

	describe("restoreQueuedPrompts", () => {
		it("restores queued prompts in steer-then-follow-up order", () => {
			let snapshot = {
				steering: [
					createQueuedMessage(2, "steer later", 20),
					createQueuedMessage(1, "steer first", 10),
				],
				followUps: [createQueuedMessage(3, "follow", 30)],
			};
			const editor = createMockEditor();
			const notificationView = createMockNotificationView();
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				clearQueuedMessages: vi.fn(() => {
					const cleared = [...snapshot.steering, ...snapshot.followUps];
					snapshot = { steering: [], followUps: [] };
					return cleared;
				}),
			});
			const controller = new QueueController({
				notificationView,
				editor,
				callbacks,
			});
			controller.syncFromAgent();

			const restored = controller.restoreQueuedPrompts();

			expect(restored.map((entry) => entry.id)).toEqual([1, 2, 3]);
			expect(editor.setText).toHaveBeenCalledWith(
				"steer first\n\nsteer later\n\nfollow",
			);
			expect(notificationView.showToast).toHaveBeenCalledWith(
				"Restored 3 queued prompts to the editor.",
				"info",
			);
		});

		it("appends the current composer draft after restored queued prompts", () => {
			let snapshot = {
				steering: [createQueuedMessage(1, "steer first", 10)],
				followUps: [createQueuedMessage(2, "follow later", 20)],
			};
			const editor = createMockEditor();
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				clearQueuedMessages: vi.fn(() => {
					const cleared = [...snapshot.steering, ...snapshot.followUps];
					snapshot = { steering: [], followUps: [] };
					return cleared;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor,
				callbacks,
			});
			controller.syncFromAgent();

			const restored = controller.restoreQueuedPrompts({
				id: 99,
				createdAt: 30,
				kind: "prompt",
				text: "existing draft",
			});

			expect(restored.map((entry) => entry.id)).toEqual([1, 2, 99]);
			expect(editor.setText).toHaveBeenCalledWith(
				"steer first\n\nfollow later\n\nexisting draft",
			);
		});

		it("returns an empty list when nothing is queued", () => {
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks: createMockCallbacks(),
			});

			expect(controller.restoreQueuedPrompts()).toEqual([]);
		});
	});

	describe("restoreLastQueuedFollowUp", () => {
		it("pops the newest queued follow-up without touching queued steers", () => {
			let snapshot = {
				steering: [createQueuedMessage(1, "steer", 10)],
				followUps: [
					createQueuedMessage(2, "follow first", 20),
					createQueuedMessage(3, "follow second", 30),
				],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				cancelQueuedMessage: vi.fn((id: number) => {
					const removed = snapshot.followUps.find((entry) => entry.id === id);
					if (!removed) {
						return null;
					}
					snapshot = {
						...snapshot,
						followUps: snapshot.followUps.filter((entry) => entry.id !== id),
					};
					return removed;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			const restored = controller.restoreLastQueuedFollowUp();

			expect(restored?.id).toBe(3);
			expect(restored?.kind).toBe("followUp");
			expect(restored?.text).toBe("follow second");
			expect(controller.getQueuedSteeringCount()).toBe(1);
			expect(controller.getQueuedFollowUpCount()).toBe(1);
		});
	});

	describe("restoreQueuedFollowUpForEditing", () => {
		it("cycles to the next older follow-up without losing the current edited draft", async () => {
			let snapshot = {
				steering: [],
				followUps: [
					createQueuedMessage(1, "follow first", 10),
					createQueuedMessage(2, "follow second", 20),
				],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				cancelQueuedMessage: vi.fn((id: number) => {
					const removed = snapshot.followUps.find((entry) => entry.id === id);
					if (!removed) {
						return null;
					}
					snapshot = {
						...snapshot,
						followUps: snapshot.followUps.filter((entry) => entry.id !== id),
					};
					return removed;
				}),
				prependQueuedFollowUp: vi.fn(async (entry: QueuedPrompt) => {
					snapshot = {
						...snapshot,
						followUps: [
							createQueuedMessage(entry.id, entry.text, entry.createdAt),
							...snapshot.followUps,
						],
					};
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();
			const initial = controller.restoreLastQueuedFollowUp();

			const restored = await controller.restoreQueuedFollowUpForEditing({
				...(initial as QueuedPrompt),
				text: "follow second edited",
			});

			expect(restored?.id).toBe(1);
			expect(restored?.text).toBe("follow first");
			expect(controller.getQueuedFollowUpCount()).toBe(1);
			expect(controller.getQueuedFollowUps()[0]?.text).toBe(
				"follow second edited",
			);
		});
	});

	describe("drainSteeringBatchForInterrupt", () => {
		it("removes the queued steering batch and preserves follow-ups", () => {
			let snapshot = {
				steering: [
					createQueuedMessage(1, "steer first", 10),
					createQueuedMessage(2, "steer second", 20),
				],
				followUps: [createQueuedMessage(3, "follow later", 30)],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				cancelQueuedMessage: vi.fn((id: number) => {
					const removed = snapshot.steering.find((entry) => entry.id === id);
					if (!removed) {
						return null;
					}
					snapshot = {
						...snapshot,
						steering: snapshot.steering.filter((entry) => entry.id !== id),
					};
					return removed;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			const drained = controller.drainSteeringBatchForInterrupt();

			expect(drained.map((entry) => entry.id)).toEqual([1, 2]);
			expect(controller.getQueuedSteeringCount()).toBe(0);
			expect(controller.getQueuedFollowUpCount()).toBe(1);
		});

		it("respects one-at-a-time steering mode", () => {
			let snapshot = {
				steering: [
					createQueuedMessage(1, "steer first", 10),
					createQueuedMessage(2, "steer second", 20),
				],
				followUps: [],
			};
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn(() => snapshot),
				cancelQueuedMessage: vi.fn((id: number) => {
					const removed = snapshot.steering.find((entry) => entry.id === id);
					if (!removed) {
						return null;
					}
					snapshot = {
						...snapshot,
						steering: snapshot.steering.filter((entry) => entry.id !== id),
					};
					return removed;
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
				initialSteeringMode: "one",
			});
			controller.syncFromAgent();

			const drained = controller.drainSteeringBatchForInterrupt();

			expect(drained.map((entry) => entry.id)).toEqual([1]);
			expect(controller.getQueuedSteeringCount()).toBe(1);
		});
	});

	describe("buildQueueHint", () => {
		it("returns null while the agent is running", () => {
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

		it("summarizes queued steers and follow-ups when idle", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [createQueuedMessage(1, "steer", 10)],
					followUps: [createQueuedMessage(2, "follow", 20)],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			expect(controller.buildQueueHint()).toBe("1 steer, 1 follow-up queued");
		});
	});

	describe("buildRunningHint", () => {
		it("adds the busy shortcut only when follow-ups can queue right now", () => {
			const callbacks = createMockCallbacks({
				getQueuedMessagesSnapshot: vi.fn().mockReturnValue({
					steering: [createQueuedMessage(1, "steer", 10)],
					followUps: [createQueuedMessage(2, "follow", 20)],
				}),
			});
			const controller = new QueueController({
				notificationView: createMockNotificationView(),
				editor: createMockEditor(),
				callbacks,
			});
			controller.syncFromAgent();

			expect(
				controller.buildRunningHint({
					baseHint: "Working… press esc to interrupt",
					canQueueFollowUp: true,
				}),
			).toBe(
				"Working… press esc to interrupt • Tab queue follow-up • 1 steer, 1 follow-up queued",
			);
			expect(
				controller.buildRunningHint({
					baseHint: "Working… press esc to interrupt",
					canQueueFollowUp: false,
				}),
			).toBe("Working… press esc to interrupt • 1 steer, 1 follow-up queued");
		});
	});
});
