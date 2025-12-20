import { isValidBase64, normalizeBase64 } from "../base64-utils.js";
import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export interface SandboxAttachment {
	id: string;
	fileName: string;
	mimeType: string;
	size: number;
	/** base64-encoded bytes */
	content: string;
	extractedText?: string;
}

export class AttachmentsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private attachments: SandboxAttachment[]) {}

	getData(): Record<string, unknown> {
		return { attachments: this.attachments };
	}

	getDescription(): string {
		return `Attachments Runtime
- listAttachments(): { id, fileName, mimeType, size }[]
- readTextAttachment(id): string
- readBinaryAttachment(id): Uint8Array`;
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			type SandboxWindow = Window &
				typeof globalThis & {
					attachments?: Array<{
						id: string;
						fileName: string;
						mimeType: string;
						size: number;
						content: string;
						extractedText?: string;
					}>;
					listAttachments?: () => Array<{
						id: string;
						fileName: string;
						mimeType: string;
						size: number;
					}>;
					readTextAttachment?: (id: string) => string;
					readBinaryAttachment?: (id: string) => Uint8Array;
				};

			const w = window as unknown as SandboxWindow;

			w.listAttachments = () =>
				(w.attachments || []).map((a) => ({
					id: a.id,
					fileName: a.fileName,
					mimeType: a.mimeType,
					size: a.size,
				}));

			w.readTextAttachment = (attachmentId: string) => {
				const a = (w.attachments || []).find((x) => x.id === attachmentId);
				if (!a) throw new Error(`Attachment not found: ${attachmentId}`);
				if (a.extractedText) return a.extractedText;
				try {
					const normalized = normalizeBase64(a.content);
					if (!isValidBase64(normalized)) {
						throw new Error("Invalid base64 content");
					}
					return atob(normalized);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "Invalid base64 content"
					) {
						throw error;
					}
					throw new Error(`Failed to decode attachment: ${attachmentId}`);
				}
			};

			w.readBinaryAttachment = (attachmentId: string) => {
				const a = (w.attachments || []).find((x) => x.id === attachmentId);
				if (!a) throw new Error(`Attachment not found: ${attachmentId}`);
				try {
					const normalized = normalizeBase64(a.content);
					if (!isValidBase64(normalized)) {
						throw new Error("Invalid base64 content");
					}
					const bin = atob(normalized);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					return bytes;
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "Invalid base64 content"
					) {
						throw error;
					}
					throw new Error(`Failed to decode attachment: ${attachmentId}`);
				}
			};
		};
	}
}
