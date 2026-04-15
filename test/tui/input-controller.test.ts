import { describe, expect, it, vi } from "vitest";
import type { PromptPayload } from "../../src/cli-tui/prompt-queue.js";
import { createInputController } from "../../src/cli-tui/tui-renderer/input-controller.js";

function createPromptPayload(text: string): PromptPayload {
	return { text };
}

function createController(options?: {
	isBashModeActive?: boolean;
	tryHandleOneOffInput?: boolean;
	tryHandleInput?: boolean;
}) {
	const editor = {
		addToHistory: vi.fn(),
	};
	const bashModeView = {
		tryHandleOneOffInput: vi.fn(
			async () => options?.tryHandleOneOffInput ?? false,
		),
		tryHandleInput: vi.fn(async () => options?.tryHandleInput ?? false),
	};
	const pasteHandler = {
		hasPending: vi.fn(() => false),
	};
	const interruptController = {
		handleInterruptRequest: vi.fn(),
		handleKeepPartialRequest: vi.fn(() => false),
	};
	const autoRetryController = {
		isRetrying: vi.fn(() => false),
		abortRetry: vi.fn(),
	};
	const consumeAttachments = vi.fn((text: string) => createPromptPayload(text));
	const getBashModeView = vi.fn(() => bashModeView as never);

	const controller = createInputController({
		deps: {
			editor: editor as never,
			getPasteHandler: () => pasteHandler as never,
			isBashModeActive: () => options?.isBashModeActive ?? false,
			getBashModeView,
			getInterruptController: () => interruptController as never,
			autoRetryController: autoRetryController as never,
			consumeAttachments,
		},
		callbacks: {
			showInfo: vi.fn(),
			stopRenderer: vi.fn(),
			exitProcess: vi.fn(),
		},
	});

	return {
		controller,
		editor,
		bashModeView,
		consumeAttachments,
		getBashModeView,
	};
}

describe("InputController", () => {
	it("does not instantiate bash mode for regular prompts while inactive", async () => {
		const { controller, consumeAttachments, getBashModeView } =
			createController();

		const payload = await controller.prepareQueuedPayload("hello world");

		expect(payload).toEqual({ text: "hello world" });
		expect(consumeAttachments).toHaveBeenCalledWith("hello world");
		expect(getBashModeView).not.toHaveBeenCalled();
	});

	it("instantiates bash mode when input starts with a bash trigger", async () => {
		const { controller, bashModeView, getBashModeView } = createController({
			tryHandleInput: true,
		});

		const payload = await controller.prepareQueuedPayload("!pwd");

		expect(payload).toBeNull();
		expect(getBashModeView).toHaveBeenCalledTimes(1);
		expect(bashModeView.tryHandleOneOffInput).toHaveBeenCalledWith("!pwd");
		expect(bashModeView.tryHandleInput).toHaveBeenCalledWith("!pwd");
	});

	it("instantiates bash mode for regular prompts when bash mode is already active", async () => {
		const { controller, bashModeView, getBashModeView } = createController({
			isBashModeActive: true,
		});

		await controller.prepareQueuedPayload("pwd");

		expect(getBashModeView).toHaveBeenCalledTimes(1);
		expect(bashModeView.tryHandleOneOffInput).toHaveBeenCalledWith("pwd");
		expect(bashModeView.tryHandleInput).toHaveBeenCalledWith("pwd");
	});
});
