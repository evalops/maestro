import type { ComposerAttachment } from "@evalops/contracts";
import { fixture, html } from "@open-wc/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-attachment-viewer.js";
import type { ComposerAttachmentViewer } from "./composer-attachment-viewer.js";

type ViewerInternals = {
	ensureBytesLoaded: (opts?: {
		force?: boolean;
		decodeText?: boolean;
	}) => Promise<void>;
	extractText: () => Promise<void>;
	loadedBytes: Uint8Array | null;
};

function createAttachment(
	overrides: Partial<ComposerAttachment> = {},
): ComposerAttachment {
	return {
		id: "att-1",
		type: "document",
		fileName: "report.pdf",
		mimeType: "application/pdf",
		size: 3,
		contentOmitted: true,
		...overrides,
	};
}

describe("ComposerAttachmentViewer", () => {
	const originalCreateObjectUrl = URL.createObjectURL;
	const originalRevokeObjectUrl = URL.revokeObjectURL;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		(
			URL as typeof URL & { createObjectURL: (blob: Blob) => string }
		).createObjectURL = vi.fn(() => "blob:test");
		(
			URL as typeof URL & { revokeObjectURL: (url: string) => void }
		).revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		(
			URL as typeof URL & { createObjectURL?: (blob: Blob) => string }
		).createObjectURL = originalCreateObjectUrl;
		(
			URL as typeof URL & { revokeObjectURL?: (url: string) => void }
		).revokeObjectURL = originalRevokeObjectUrl;
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("loads omitted session attachments through the shared api client", async () => {
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as typeof fetch;
		const getSessionAttachmentBytes = vi
			.fn()
			.mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
		const apiClient = {
			baseUrl: "http://localhost:8080",
			getSessionAttachmentBytes,
		} as unknown as ApiClient;

		const element = await fixture<ComposerAttachmentViewer>(
			html`<composer-attachment-viewer
				.open=${true}
				.attachment=${createAttachment()}
				.apiClient=${apiClient}
				.sessionId=${"session-1"}
			></composer-attachment-viewer>`,
		);
		const viewer = element as unknown as ViewerInternals;

		await viewer.ensureBytesLoaded({ decodeText: false });

		expect(getSessionAttachmentBytes).toHaveBeenCalledWith(
			"session-1",
			"att-1",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(Array.from(viewer.loadedBytes ?? [])).toEqual([1, 2, 3]);
	});

	it("extracts session attachments through the shared api client", async () => {
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as typeof fetch;
		const extractSessionAttachmentText = vi.fn().mockResolvedValue({
			fileName: "report.pdf",
			format: "pdf",
			size: 3,
			truncated: false,
			extractedText: "Extracted text",
		});
		const apiClient = {
			baseUrl: "http://localhost:8080",
			extractSessionAttachmentText,
		} as unknown as ApiClient;

		const element = await fixture<ComposerAttachmentViewer>(
			html`<composer-attachment-viewer
				.open=${true}
				.attachment=${createAttachment()}
				.apiClient=${apiClient}
				.sessionId=${"session-1"}
			></composer-attachment-viewer>`,
		);
		const viewer = element as unknown as ViewerInternals;

		await viewer.extractText();

		expect(extractSessionAttachmentText).toHaveBeenCalledWith(
			"session-1",
			"att-1",
		);
		expect(element.attachment?.extractedText).toBe("Extracted text");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
