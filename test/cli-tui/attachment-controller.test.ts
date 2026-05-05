import { describe, expect, it, vi } from "vitest";

vi.mock("@crosscopy/clipboard", () => {
	throw new Error("clipboard native package should load lazily");
});

import { createAttachmentController } from "../../src/cli-tui/tui-renderer/attachment-controller.js";

function createController() {
	return createAttachmentController({
		deps: {
			insertEditorText: vi.fn(),
			setEditorText: vi.fn(),
		},
		callbacks: {
			requestRender: vi.fn(),
		},
	});
}

describe("AttachmentController", () => {
	it("does not require the native clipboard package at module import time", () => {
		const controller = createController();

		expect(controller.snapshotAttachments("hello")).toEqual({ text: "hello" });
	});

	it("ignores unavailable native clipboard bindings during image paste", async () => {
		const controller = createController();

		await expect(
			controller.handleClipboardImagePaste(),
		).resolves.toBeUndefined();
		expect(controller.hasPendingAttachments()).toBe(false);
	});
});
