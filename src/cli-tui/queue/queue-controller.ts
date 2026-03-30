import type {
	AppMessage,
	Attachment,
	QueuedMessage,
} from "../../agent/types.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import type { PromptKind, PromptQueue, QueuedPrompt } from "../prompt-queue.js";

/**
 * Queue mode determines how prompts are handled when the agent is running.
 * - "all": Submissions are queued while agent is running
 * - "one": Submissions are blocked until current run finishes
 */
export type QueueMode = "one" | "all";
export type QueueModeKind = "steering" | "followUp";

function queuePriority(kind: PromptKind): number {
	return kind === "steer" ? 0 : kind === "followUp" ? 1 : 2;
}

function extractQueuedText(message: AppMessage): string {
	if (message.role !== "user") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractQueuedAttachments(
	message: AppMessage,
): Attachment[] | undefined {
	if (message.role !== "user" || !("attachments" in message)) {
		return undefined;
	}
	const attachments = message.attachments;
	return attachments?.length ? [...attachments] : undefined;
}

function toQueuedPrompt(
	queued: QueuedMessage<AppMessage>,
	kind: Exclude<PromptKind, "prompt">,
): QueuedPrompt {
	return {
		id: queued.id,
		createdAt: queued.createdAt,
		kind,
		text: extractQueuedText(queued.original),
		attachments: extractQueuedAttachments(queued.original),
	};
}

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
	/** Read queued messages from the agent */
	getQueuedMessagesSnapshot(): {
		steering: ReadonlyArray<QueuedMessage<AppMessage>>;
		followUps: ReadonlyArray<QueuedMessage<AppMessage>>;
	};
	/** Cancel a queued message by id */
	cancelQueuedMessage(id: number): QueuedMessage<AppMessage> | null;
	/** Clear all queued messages */
	clearQueuedMessages(): Array<QueuedMessage<AppMessage>>;
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
 * Controller for managing steer/follow-up queue state and operations.
 */
export class QueueController {
	private readonly notificationView: NotificationView;
	private readonly editor: CustomEditor;
	private readonly callbacks: QueueControllerCallbacks;

	// The interactive runtime still wires a PromptQueue, but steer/follow-up
	// state is now sourced from the agent's real collaboration queues.
	private promptQueue?: PromptQueue;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private queuedSteering: QueuedPrompt[] = [];
	private queuedFollowUps: QueuedPrompt[] = [];
	private queuedPromptCount = 0;
	private nextQueuedPreview: string | null = null;

	constructor(options: QueueControllerOptions) {
		this.notificationView = options.notificationView;
		this.editor = options.editor;
		this.callbacks = options.callbacks;
		this.steeringMode = options.initialSteeringMode ?? "all";
		this.followUpMode = options.initialFollowUpMode ?? "all";
	}

	attach(queue: PromptQueue): void {
		this.promptQueue = queue;
		this.syncFromAgent();
	}

	detach(): void {
		this.promptQueue = undefined;
	}

	getSteeringMode(): QueueMode {
		return this.steeringMode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpMode;
	}

	isFollowUpEnabled(): boolean {
		return this.followUpMode === "all";
	}

	isSteeringEnabled(): boolean {
		return this.steeringMode === "all";
	}

	getQueuedCount(): number {
		return this.queuedPromptCount;
	}

	getQueuedSteeringCount(): number {
		return this.queuedSteering.length;
	}

	getQueuedFollowUpCount(): number {
		return this.queuedFollowUps.length;
	}

	getNextPreview(): string | null {
		return this.nextQueuedPreview;
	}

	getPendingSteers(): QueuedPrompt[] {
		return [...this.queuedSteering];
	}

	getQueuedFollowUps(): QueuedPrompt[] {
		return [...this.queuedFollowUps];
	}

	hasQueue(): boolean {
		return true;
	}

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

	cancel(id: number): boolean {
		const removed = this.callbacks.cancelQueuedMessage(id);
		if (!removed) {
			return false;
		}
		this.syncFromAgent();
		this.callbacks.refreshFooterHint();
		return true;
	}

	cancelAll(_options?: { silent?: boolean }): void {
		this.callbacks.clearQueuedMessages();
		this.syncFromAgent();
	}

	getSnapshot(): { active?: QueuedPrompt; pending: QueuedPrompt[] } {
		return {
			pending: [...this.queuedSteering, ...this.queuedFollowUps],
		};
	}

	canQueueSteering(): boolean {
		return this.steeringMode === "all";
	}

	canQueueFollowUp(): boolean {
		return this.followUpMode === "all";
	}

	restoreQueuedPrompts(): QueuedPrompt[] {
		const queuedKinds = new Map<number, Exclude<PromptKind, "prompt">>();
		for (const entry of this.queuedSteering) {
			queuedKinds.set(entry.id, "steer");
		}
		for (const entry of this.queuedFollowUps) {
			queuedKinds.set(entry.id, "followUp");
		}
		const restored = this.callbacks
			.clearQueuedMessages()
			.map((entry) =>
				toQueuedPrompt(entry, queuedKinds.get(entry.id) ?? "followUp"),
			);

		if (!restored.length) {
			this.syncFromAgent();
			return [];
		}

		const ordered = restored.sort(
			(a, b) =>
				queuePriority(a.kind) - queuePriority(b.kind) ||
				a.createdAt - b.createdAt ||
				a.id - b.id,
		);
		const segments = ordered
			.map((entry) => entry.text.trim())
			.filter((segment) => segment.length > 0);
		this.editor.setText(segments.join("\n\n"));
		this.notificationView.showToast(
			`Restored ${ordered.length} queued prompt${ordered.length === 1 ? "" : "s"} to the editor.`,
			"info",
		);
		this.syncFromAgent();
		this.callbacks.refreshFooterHint();
		return ordered;
	}

	buildQueueHint(): string | null {
		if (this.callbacks.isAgentRunning()) {
			return null;
		}
		if (this.queuedSteering.length > 0 || this.queuedFollowUps.length > 0) {
			const parts = [];
			if (this.queuedSteering.length > 0) {
				parts.push(`${this.queuedSteering.length} steer`);
			}
			if (this.queuedFollowUps.length > 0) {
				parts.push(`${this.queuedFollowUps.length} follow-up`);
			}
			return `${parts.join(", ")} queued`;
		}
		if (this.nextQueuedPreview) {
			return `Next queued: ${this.nextQueuedPreview}`;
		}
		return null;
	}

	syncFromAgent(): void {
		const snapshot = this.callbacks.getQueuedMessagesSnapshot();
		this.queuedSteering = snapshot.steering
			.map((entry) => toQueuedPrompt(entry, "steer"))
			.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
		this.queuedFollowUps = snapshot.followUps
			.map((entry) => toQueuedPrompt(entry, "followUp"))
			.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
		this.queuedPromptCount =
			this.queuedSteering.length + this.queuedFollowUps.length;
		const next = this.queuedSteering[0] ?? this.queuedFollowUps[0];
		this.nextQueuedPreview = next
			? `${this.describePromptKind(next.kind)}: ${this.formatQueuedText(next.text, 60)}`
			: null;
		this.callbacks.onQueueCountChange?.(this.queuedPromptCount);
		if (!this.callbacks.isAgentRunning()) {
			this.callbacks.refreshFooterHint();
		}
		this.callbacks.requestRender();
	}

	private formatQueuedText(message: string, maxLength = 80): string {
		const singleLine = message.replace(/\s+/g, " ").trim();
		if (singleLine.length <= maxLength) {
			return singleLine || "(empty message)";
		}
		return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
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
