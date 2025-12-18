import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider.js";

export interface DownloadableFile {
	fileName: string;
	content: string | Uint8Array;
	mimeType: string;
	ts: number;
}

export interface SandboxDownloadsSnapshot {
	files: DownloadableFile[];
	updatedAt: number;
}

const STORE = new Map<string, SandboxDownloadsSnapshot>();

function ensureSnapshot(sandboxId: string): SandboxDownloadsSnapshot {
	const existing = STORE.get(sandboxId);
	if (existing) return existing;
	const next: SandboxDownloadsSnapshot = { files: [], updatedAt: Date.now() };
	STORE.set(sandboxId, next);
	return next;
}

export function clearSandboxDownloadsSnapshot(sandboxId: string): void {
	STORE.set(sandboxId, { files: [], updatedAt: Date.now() });
}

export function getSandboxDownloadsSnapshot(
	sandboxId: string,
): SandboxDownloadsSnapshot | null {
	return STORE.get(sandboxId) ?? null;
}

function downloadInHost(file: DownloadableFile): void {
	const blob = new Blob(
		[file.content instanceof Uint8Array ? file.content : file.content],
		{ type: file.mimeType },
	);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = file.fileName;
	a.rel = "noopener";
	a.click();
	URL.revokeObjectURL(url);
}

export class FileDownloadRuntimeProvider implements SandboxRuntimeProvider {
	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return "returnDownloadableFile(filename, content, mimeType?) - create a downloadable file (one-time download)";
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			type SandboxWindow = Window &
				typeof globalThis & {
					postRuntimeMessage?: (message: unknown) => void;
					returnDownloadableFile?: (
						fileName: string,
						content: unknown,
						mimeType?: string,
					) => Promise<void>;
				};
			const w = window as unknown as SandboxWindow;

			const post =
				w.postRuntimeMessage ??
				((message: unknown) => {
					try {
						window.parent.postMessage(message, "*");
					} catch {
						// ignore
					}
				});

			w.returnDownloadableFile = async (
				fileName: string,
				content: unknown,
				mimeType?: string,
			): Promise<void> => {
				let finalContent: string | Uint8Array;
				let finalMimeType: string;

				if (content instanceof Blob) {
					const ab = await content.arrayBuffer();
					finalContent = new Uint8Array(ab);
					finalMimeType =
						mimeType || content.type || "application/octet-stream";
				} else if (content instanceof Uint8Array) {
					if (!mimeType) {
						throw new Error(
							"returnDownloadableFile: mimeType is required for Uint8Array content",
						);
					}
					finalContent = content;
					finalMimeType = mimeType;
				} else if (typeof content === "string") {
					finalContent = content;
					finalMimeType = mimeType || "text/plain";
				} else {
					finalContent = JSON.stringify(content, null, 2);
					finalMimeType = mimeType || "application/json";
				}

				post({
					type: "file-returned",
					fileName,
					content: finalContent,
					mimeType: finalMimeType,
				});
			};
		};
	}

	async handleMessage(
		message: unknown,
		respond: (response: unknown) => void,
	): Promise<void> {
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;
		if (m.type !== "file-returned") return;

		const sandboxId = typeof m.sandboxId === "string" ? m.sandboxId : "sandbox";
		const fileName = typeof m.fileName === "string" ? m.fileName : "download";
		const mimeType =
			typeof m.mimeType === "string" ? m.mimeType : "application/octet-stream";
		const raw = m.content;

		let content: string | Uint8Array;
		if (raw instanceof Uint8Array) {
			content = raw;
		} else if (typeof raw === "string") {
			content = raw;
		} else if (raw && typeof raw === "object") {
			// Best-effort fallback
			content = JSON.stringify(raw, null, 2);
		} else {
			content = "";
		}

		const file: DownloadableFile = {
			fileName,
			content,
			mimeType,
			ts: Date.now(),
		};

		const snap = ensureSnapshot(sandboxId);
		snap.files.push(file);
		snap.updatedAt = Date.now();

		// Trigger download in host (more reliable than sandboxed iframe downloads).
		try {
			downloadInHost(file);
		} catch {
			// ignore
		}

		respond({ success: true });
	}
}
