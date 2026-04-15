/**
 * AttachmentController — Manages pending image/file attachments.
 *
 * Tracks clipboard-pasted images and their marker tokens in the editor,
 * and resolves them into Attachment objects when the user submits a prompt.
 */

import { randomUUID } from "node:crypto";
import Clipboard from "@crosscopy/clipboard";
import type { Attachment } from "../../agent/types.js";
import type { PromptPayload, QueuedPrompt } from "../prompt-queue.js";

// ─── Callback & Dependency Interfaces ────────────────────────────────────────

export interface AttachmentControllerCallbacks {
	/** Request a UI render cycle. */
	requestRender: () => void;
}

export interface AttachmentControllerDeps {
	/** Insert text at the editor cursor position. */
	insertEditorText: (text: string) => void;
	/** Set the full editor text. */
	setEditorText: (text: string) => void;
}

export interface AttachmentControllerOptions {
	deps: AttachmentControllerDeps;
	callbacks: AttachmentControllerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class AttachmentController {
	private readonly deps: AttachmentControllerDeps;
	private readonly callbacks: AttachmentControllerCallbacks;
	private pendingAttachments = new Map<number, Attachment>();
	private pendingAttachmentCounter = 0;

	constructor(options: AttachmentControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/** Remove all pending attachments and reset the counter. */
	clearPendingAttachments(): void {
		this.pendingAttachments.clear();
		this.pendingAttachmentCounter = 0;
	}

	/** Whether there are pending attachments awaiting submission. */
	hasPendingAttachments(): boolean {
		return this.pendingAttachments.size > 0;
	}

	/**
	 * Replace attachment markers in the submitted text with descriptive labels
	 * and return the resolved attachments alongside the updated text.
	 */
	consumeAttachments(text: string): PromptPayload {
		const { text: updatedText, attachments } =
			this.resolvePendingAttachmentMarkers(text, { consume: true });
		return {
			text: updatedText,
			attachments: attachments.length > 0 ? attachments : undefined,
		};
	}

	/**
	 * Build the current prompt payload without consuming the editor markers.
	 */
	snapshotAttachments(text: string): PromptPayload {
		const { text: updatedText, attachments } =
			this.resolvePendingAttachmentMarkers(text, { consume: false });
		return {
			text: updatedText,
			attachments: attachments.length > 0 ? attachments : undefined,
		};
	}

	/**
	 * Read an image from the system clipboard and register it as a pending
	 * attachment, inserting a marker into the editor.
	 */
	async handleClipboardImagePaste(): Promise<void> {
		try {
			if (!Clipboard.hasImage()) {
				return;
			}
			const imageData = await Clipboard.getImageBinary();
			if (!imageData || imageData.length === 0) {
				return;
			}
			const attachmentId = `att_${randomUUID()}`;
			const fileName = `clipboard-image-${attachmentId.slice(-6)}.png`;
			const attachment: Attachment = {
				id: attachmentId,
				type: "image",
				fileName,
				mimeType: "image/png",
				size: imageData.length,
				content: Buffer.from(imageData).toString("base64"),
			};
			const markerId = ++this.pendingAttachmentCounter;
			this.pendingAttachments.set(markerId, attachment);
			this.deps.insertEditorText(`[image #${markerId}]`);
			this.callbacks.requestRender();
		} catch {
			// Ignore clipboard errors (permissions, empty clipboard, etc.)
		}
	}

	/**
	 * Re-register attachments from cancelled/restored queue entries so their
	 * markers resolve correctly on resubmission.
	 */
	restoreQueuedAttachments(entries: QueuedPrompt[]): void {
		const restored = entries.some(
			(entry) => (entry.attachments?.length ?? 0) > 0,
		);
		if (!restored) {
			return;
		}
		this.clearPendingAttachments();
		const segments: string[] = [];
		for (const entry of entries) {
			let segment = entry.text;
			const attachments = entry.attachments ?? [];
			if (attachments.length > 0) {
				const markers: string[] = [];
				for (const attachment of attachments) {
					const markerId = ++this.pendingAttachmentCounter;
					this.pendingAttachments.set(markerId, attachment);
					markers.push(`[image #${markerId}]`);
				}
				if (markers.length > 0) {
					const trimmed = segment.trim();
					segment =
						trimmed.length > 0
							? `${trimmed}\n${markers.join(" ")}`
							: markers.join(" ");
				}
			}
			segments.push(segment);
		}
		const restoredText = segments
			.filter((s) => s.trim().length > 0)
			.join("\n\n");
		if (restoredText) {
			this.deps.setEditorText(restoredText);
		}
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private resolvePendingAttachmentMarkers(
		text: string,
		options: { consume: boolean },
	): {
		text: string;
		attachments: Attachment[];
	} {
		if (this.pendingAttachments.size === 0) {
			return { text, attachments: [] };
		}
		let updated = text;
		const attachments: Attachment[] = [];
		for (const [id, attachment] of this.pendingAttachments) {
			const marker = `[image #${id}]`;
			if (!updated.includes(marker)) {
				continue;
			}
			const replacement = `[attachment] ${attachment.fileName} (${attachment.mimeType})`;
			updated = updated.split(marker).join(replacement);
			attachments.push(attachment);
		}
		if (options.consume) {
			this.clearPendingAttachments();
		}
		return { text: updated, attachments };
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createAttachmentController(
	options: AttachmentControllerOptions,
): AttachmentController {
	return new AttachmentController(options);
}
