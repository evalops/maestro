import type { Attachment } from "../../agent/types.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import type {
	PromptKind,
	PromptQueue,
	PromptQueueEvent,
	QueuedPrompt,
} from "../prompt-queue.js";

/**
 * Queue mode determines how prompts are handled when the agent is running.
 * - "all": Submissions are queued while agent is running
 * - "one": Submissions are blocked until current run finishes
 */
export type QueueMode = "one" | "all";
export type QueueModeKind = "steering" | "followUp";

/**
 * Callbacks for the queue controller.
 */
export interface QueueControllerCallbacks {
	/** Called when queue mode changes */
	onModeChange?(kind: QueueModeKind, mode: QueueMode): void;
	/** Called when queue count changes */
	onQueueCountChange?(count: number): void;
	/** Check if agent is currently running */
	isAgentRunning(): boolean;
	/** Refresh footer hint */
	refreshFooterHint(): void;
	/** Request UI render */
	requestRender(): void;
	/** Persist UI state */
	persistUiState(state: {
		steeringMode?: QueueMode;
		followUpMode?: QueueMode;
	}): void;
}

/**
 * Options for the queue controller.
 */
export interface QueueControllerOptions {
	notificationView: NotificationView;
	editor: CustomEditor;
	callbacks: QueueControllerCallbacks;
	initialSteeringMode?: QueueMode;
	initialFollowUpMode?: QueueMode;
}

/**
 * Controller for managing prompt queue state and operations.
 *
 * Handles:
 * - Queue mode switching (one vs all)
 * - Queue event handling
 * - Prompt restoration on interrupt
 */
export class QueueController {
	private readonly notificationView: NotificationView;
	private readonly editor: CustomEditor;
	private readonly callbacks: QueueControllerCallbacks;

	private promptQueue?: PromptQueue;
	private promptQueueUnsubscribe?: () => void;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private queuedPromptCount = 0;
	private queuedSteeringCount = 0;
	private queuedFollowUpCount = 0;
	private nextQueuedPreview: string | null = null;

	constructor(options: QueueControllerOptions) {
		this.notificationView = options.notificationView;
		this.editor = options.editor;
		this.callbacks = options.callbacks;
		this.steeringMode = options.initialSteeringMode ?? "all";
		this.followUpMode = options.initialFollowUpMode ?? "all";
	}

	/**
	 * Attach a prompt queue to this controller.
	 */
	attach(queue: PromptQueue): void {
		this.promptQueue = queue;
		this.promptQueueUnsubscribe?.();
		this.promptQueueUnsubscribe = queue.subscribe((event) =>
			this.handleEvent(event),
		);
		// Sync counts immediately in case the queue already has pending entries.
		this.updateQueuedPromptCount();
		if (!this.callbacks.isAgentRunning()) {
			this.callbacks.refreshFooterHint();
		}
		this.callbacks.requestRender();
	}

	/**
	 * Detach the prompt queue.
	 */
	detach(): void {
		this.promptQueueUnsubscribe?.();
		this.promptQueueUnsubscribe = undefined;
		this.promptQueue = undefined;
	}

	/**
	 * Get the current queue mode.
	 */
	getSteeringMode(): QueueMode {
		return this.steeringMode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpMode;
	}

	/**
	 * Check if follow-up queueing is enabled.
	 */
	isFollowUpEnabled(): boolean {
		return this.followUpMode === "all";
	}

	isSteeringEnabled(): boolean {
		return this.steeringMode === "all";
	}

	/**
	 * Get count of queued prompts.
	 */
	getQueuedCount(): number {
		return this.queuedPromptCount;
	}

	getQueuedSteeringCount(): number {
		return this.queuedSteeringCount;
	}

	getQueuedFollowUpCount(): number {
		return this.queuedFollowUpCount;
	}

	/**
	 * Get preview text for next queued prompt.
	 */
	getNextPreview(): string | null {
		return this.nextQueuedPreview;
	}

	/**
	 * Check if a prompt queue is attached.
	 */
	hasQueue(): boolean {
		return Boolean(this.promptQueue);
	}

	/**
	 * Set the queue mode.
	 */
	setMode(kind: QueueModeKind, mode: QueueMode): void {
		if (kind === "steering") {
			this.steeringMode = mode;
		} else {
			this.followUpMode = mode;
		}
		this.callbacks.persistUiState({
			steeringMode: this.steeringMode,
			followUpMode: this.followUpMode,
		});
		const label = kind === "steering" ? "Steering" : "Follow-up";
		this.notificationView.showToast(
			mode === "all"
				? `${label} mode set to all: messages can queue while running.`
				: `${label} mode set to one-at-a-time: queue pauses while running.`,
			"success",
		);
		this.callbacks.refreshFooterHint();
		this.callbacks.onModeChange?.(kind, mode);
	}

	/**
	 * Cancel a specific queued prompt.
	 */
	cancel(id: number): boolean {
		if (!this.promptQueue) {
			return false;
		}
		const removed = this.promptQueue.cancel(id);
		if (removed) {
			this.updateQueuedPromptCount();
			this.callbacks.refreshFooterHint();
			return true;
		}
		return false;
	}

	/**
	 * Cancel all queued prompts.
	 */
	cancelAll(options?: { silent?: boolean }): void {
		this.promptQueue?.cancelAll?.(options);
		this.nextQueuedPreview = null;
		this.updateQueuedPromptCount();
	}

	/**
	 * Enqueue a prompt, optionally prioritizing it ahead of existing entries.
	 */
	enqueuePrompt(
		text: string,
		options?: {
			front?: boolean;
			attachments?: Attachment[];
			kind?: PromptKind;
		},
	): QueuedPrompt | null {
		if (!this.promptQueue) {
			return null;
		}
		return options?.front
			? this.promptQueue.enqueueFront(
					text,
					options.attachments,
					options.kind ?? "prompt",
				)
			: this.promptQueue.enqueue(
					text,
					options?.attachments,
					options?.kind ?? "prompt",
				);
	}

	/**
	 * Get a snapshot of the current queue state.
	 */
	getSnapshot(): { active?: QueuedPrompt; pending: QueuedPrompt[] } {
		if (!this.promptQueue) {
			return { pending: [] };
		}
		return this.promptQueue.getSnapshot();
	}

	canQueueSteering(): boolean {
		return this.steeringMode === "all";
	}

	canQueueFollowUp(): boolean {
		return this.followUpMode === "all";
	}

	/**
	 * Restore queued prompts to the editor on interrupt.
	 */
	restoreQueuedPrompts(): QueuedPrompt[] {
		if (!this.promptQueue) {
			return [];
		}
		const snapshot = this.promptQueue.getSnapshot();
		const entries: QueuedPrompt[] = [];
		const messages: string[] = [];
		if (snapshot.active) {
			messages.push(snapshot.active.text);
			entries.push(snapshot.active);
		}
		for (const entry of snapshot.pending) {
			messages.push(entry.text);
			entries.push(entry);
		}
		if (!messages.length) {
			return [];
		}
		const restored = messages.join("\n\n");
		this.promptQueue.cancelAll?.({ silent: true });
		this.promptQueue.clearActive?.();
		this.editor.setText(restored);
		this.notificationView.showToast(
			`Restored ${messages.length} queued prompt${messages.length === 1 ? "" : "s"} to the editor.`,
			"info",
		);
		this.updateQueuedPromptCount();
		this.callbacks.refreshFooterHint();
		return entries;
	}

	/**
	 * Build hint text for the queue.
	 */
	buildQueueHint(): string | null {
		if (this.callbacks.isAgentRunning()) {
			return null;
		}
		if (this.queuedSteeringCount > 0 || this.queuedFollowUpCount > 0) {
			const parts = [];
			if (this.queuedSteeringCount > 0) {
				parts.push(`${this.queuedSteeringCount} steer`);
			}
			if (this.queuedFollowUpCount > 0) {
				parts.push(`${this.queuedFollowUpCount} follow-up`);
			}
			return `${parts.join(", ")} queued`;
		}
		if (this.nextQueuedPreview) {
			return `Next queued: ${this.nextQueuedPreview}`;
		}
		if (this.queuedPromptCount > 0) {
			return `${this.queuedPromptCount} queued ${this.queuedPromptCount === 1 ? "prompt" : "prompts"}`;
		}
		return null;
	}

	private handleEvent(event: PromptQueueEvent): void {
		if (!this.promptQueue) {
			return;
		}
		if (event.type === "error") {
			const message = this.describeError(event.error);
			this.notificationView.showError(
				`Prompt #${event.entry.id} failed: ${message}`,
			);
		}
		if (event.type === "enqueue" && !event.willRunImmediately) {
			const label = this.describePromptKind(event.entry.kind);
			this.notificationView.showInfo(
				`Queued ${label} #${event.entry.id} (${event.pendingCount} pending)`,
			);
		}
		if (event.type === "cancel") {
			this.notificationView.showInfo(
				`Removed queued prompt #${event.entry.id}`,
			);
		}
		this.updateQueuedPromptCount();
		if (!this.callbacks.isAgentRunning()) {
			this.callbacks.refreshFooterHint();
		}
		this.callbacks.requestRender();
	}

	private updateQueuedPromptCount(): void {
		if (!this.promptQueue) {
			this.queuedPromptCount = 0;
			this.queuedSteeringCount = 0;
			this.queuedFollowUpCount = 0;
			this.nextQueuedPreview = null;
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		this.queuedPromptCount = snapshot.pending.length;
		this.queuedSteeringCount = snapshot.pending.filter(
			(entry) => entry.kind === "steer",
		).length;
		this.queuedFollowUpCount = snapshot.pending.filter(
			(entry) => entry.kind === "followUp",
		).length;
		const next = snapshot.pending[0];
		this.nextQueuedPreview = next
			? `${this.describePromptKind(next.kind)}: ${this.formatQueuedText(next.text, 60)}`
			: null;
		this.callbacks.onQueueCountChange?.(this.queuedPromptCount);
	}

	private formatQueuedText(message: string, maxLength = 80): string {
		const singleLine = message.replace(/\s+/g, " ").trim();
		if (singleLine.length <= maxLength) {
			return singleLine || "(empty message)";
		}
		return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
	}

	private describeError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error ?? "Unknown error");
	}

	private describePromptKind(kind: PromptKind): string {
		if (kind === "steer") {
			return "steer";
		}
		if (kind === "followUp") {
			return "follow-up";
		}
		return "prompt";
	}
}
