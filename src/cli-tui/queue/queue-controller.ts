import type {
	AppMessage,
	Attachment,
	QueuedMessage,
} from "../../agent/types.js";
import type { CustomEditor } from "../custom-editor.js";
import type { NotificationView } from "../notification-view.js";
import type { PromptKind, QueuedPrompt } from "../prompt-queue.js";
import { getQueuedFollowUpEditBindingLabel } from "./queued-follow-up-edit-binding.js";

/**
 * Queue mode determines how prompts are handled when the agent is running.
 * - "all": Submissions are queued while agent is running
 * - "one": Submissions are blocked until current run finishes
 */
export type QueueMode = "one" | "all";
export type QueueModeKind = "steering" | "followUp";
const MAX_INLINE_PREVIEW_ITEMS = 3;
const MAX_INLINE_PREVIEW_CHARS = 72;

function getEditLastFollowUpHint(): string {
	return `${getQueuedFollowUpEditBindingLabel()} edit queued follow-ups`;
}

function getInterruptSteeringHint(): string {
	return "Esc interrupt and apply now";
}

function formatNextBatchNote(count: number, mode: QueueMode): string | null {
	if (count <= 1) {
		return null;
	}
	return mode === "all"
		? `next batch: all ${count}`
		: `next batch: 1 of ${count}`;
}

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
	/** Reinsert an edited follow-up at the front of the follow-up queue */
	prependQueuedFollowUp(entry: QueuedPrompt): Promise<void>;
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

	getNextSteeringBatchSummary(): string | null {
		return this.describeNextBatch(
			"steer",
			this.queuedSteering.length,
			this.steeringMode,
		);
	}

	getNextFollowUpBatchSummary(): string | null {
		return this.describeNextBatch(
			"followUp",
			this.queuedFollowUps.length,
			this.followUpMode,
		);
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

	restoreQueuedPrompts(currentDraft?: QueuedPrompt | null): QueuedPrompt[] {
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
		if (currentDraft) {
			ordered.push(currentDraft);
		}
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

	restoreLastQueuedFollowUp(): QueuedPrompt | null {
		const latest = this.queuedFollowUps.at(-1);
		if (!latest) {
			return null;
		}
		const removed = this.callbacks.cancelQueuedMessage(latest.id);
		if (!removed) {
			this.syncFromAgent();
			return null;
		}
		const restored = toQueuedPrompt(removed, "followUp");
		this.syncFromAgent();
		return restored;
	}

	async restoreQueuedFollowUpForEditing(
		currentDraft?: QueuedPrompt | null,
	): Promise<QueuedPrompt | null> {
		if (currentDraft && this.queuedFollowUps.length === 0) {
			return null;
		}
		if (currentDraft) {
			await this.callbacks.prependQueuedFollowUp(currentDraft);
			this.syncFromAgent();
		}
		return this.restoreLastQueuedFollowUp();
	}

	drainSteeringBatchForInterrupt(): QueuedPrompt[] {
		if (this.queuedSteering.length === 0) {
			return [];
		}
		const limit = this.steeringMode === "all" ? this.queuedSteering.length : 1;
		const drained: QueuedPrompt[] = [];
		for (const queued of this.queuedSteering.slice(0, limit)) {
			const removed = this.callbacks.cancelQueuedMessage(queued.id);
			if (!removed) {
				continue;
			}
			drained.push(toQueuedPrompt(removed, "steer"));
		}
		this.syncFromAgent();
		this.callbacks.refreshFooterHint();
		return drained.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
	}

	buildQueueHint(): string | null {
		if (this.callbacks.isAgentRunning()) {
			return null;
		}
		const queuedSummary = this.buildQueuedSummary();
		if (queuedSummary) {
			return queuedSummary;
		}
		if (this.nextQueuedPreview) {
			return `Next queued: ${this.nextQueuedPreview}`;
		}
		return null;
	}

	buildRunningHint(options?: {
		baseHint?: string;
		canQueueFollowUp?: boolean;
	}): string {
		const segments = [
			options?.baseHint?.trim() || "Working… press esc to interrupt",
		];
		if (options?.canQueueFollowUp) {
			segments.push("Tab queue follow-up");
		}
		const queuedSummary = this.buildQueuedSummary();
		if (queuedSummary) {
			segments.push(queuedSummary);
		}
		return segments.join(" • ");
	}

	buildInlinePreview(): string {
		const sections: string[] = [];
		if (this.queuedSteering.length > 0) {
			sections.push(
				this.buildInlinePreviewSection(
					this.buildInlinePreviewTitle(
						"Queued steering after next tool boundary",
						this.queuedSteering.length,
						this.steeringMode,
					),
					this.queuedSteering,
					getInterruptSteeringHint(),
				),
			);
		}
		if (this.queuedFollowUps.length > 0) {
			sections.push(
				this.buildInlinePreviewSection(
					this.buildInlinePreviewTitle(
						"Queued follow-ups after turn end",
						this.queuedFollowUps.length,
						this.followUpMode,
					),
					this.queuedFollowUps,
					getEditLastFollowUpHint(),
				),
			);
		}
		return sections.join("\n\n");
	}

	syncFromAgent(): void {
		const snapshot = this.callbacks.getQueuedMessagesSnapshot();
		this.queuedSteering = snapshot.steering.map((entry) =>
			toQueuedPrompt(entry, "steer"),
		);
		this.queuedFollowUps = snapshot.followUps.map((entry) =>
			toQueuedPrompt(entry, "followUp"),
		);
		this.queuedPromptCount =
			this.queuedSteering.length + this.queuedFollowUps.length;
		const next = this.queuedSteering[0] ?? this.queuedFollowUps[0];
		this.nextQueuedPreview = next
			? `${this.describePromptKind(next.kind)}: ${this.formatQueuedText(next.text, 60)}`
			: null;
		this.callbacks.onQueueCountChange?.(this.queuedPromptCount);
		this.callbacks.refreshFooterHint();
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

	private buildQueuedSummary(): string | null {
		if (this.queuedSteering.length === 0 && this.queuedFollowUps.length === 0) {
			return null;
		}
		const parts = [];
		if (this.queuedSteering.length > 0) {
			parts.push(`${this.queuedSteering.length} steer`);
		}
		if (this.queuedFollowUps.length > 0) {
			parts.push(`${this.queuedFollowUps.length} follow-up`);
		}
		return `${parts.join(", ")} queued`;
	}

	private describeNextBatch(
		kind: Exclude<PromptKind, "prompt">,
		count: number,
		mode: QueueMode,
	): string | null {
		if (count === 0) {
			return null;
		}
		const timing =
			kind === "steer" ? "at the next tool boundary" : "after turn end";
		const batch =
			count === 1
				? "1 message"
				: mode === "all"
					? `all ${count} messages`
					: `1 of ${count} messages`;
		return `${batch} ${timing}`;
	}

	private buildInlinePreviewTitle(
		base: string,
		count: number,
		mode: QueueMode,
	): string {
		const note = formatNextBatchNote(count, mode);
		return note ? `${base} (${note})` : base;
	}

	private buildInlinePreviewSection(
		title: string,
		entries: QueuedPrompt[],
		footer?: string,
	): string {
		const lines = [title];
		for (const entry of entries.slice(0, MAX_INLINE_PREVIEW_ITEMS)) {
			lines.push(
				`  ↳ ${this.formatQueuedText(entry.text, MAX_INLINE_PREVIEW_CHARS)}`,
			);
		}
		const remaining = entries.length - MAX_INLINE_PREVIEW_ITEMS;
		if (remaining > 0) {
			lines.push(`  … ${remaining} more`);
		}
		if (footer) {
			lines.push(`  ${footer}`);
		}
		return lines.join("\n");
	}
}
