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
					return atob(a.content);
				} catch {
					throw new Error(`Failed to decode attachment: ${attachmentId}`);
				}
			};

			w.readBinaryAttachment = (attachmentId: string) => {
				const a = (w.attachments || []).find((x) => x.id === attachmentId);
				if (!a) throw new Error(`Attachment not found: ${attachmentId}`);
				const bin = atob(a.content);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				return bytes;
			};
		};
	}
}
