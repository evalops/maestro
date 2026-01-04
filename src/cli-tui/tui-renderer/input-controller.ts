/**
 * InputController - Handles editor input submission and interrupt wiring.
 *
 * Keeps input lifecycle logic out of TuiRenderer while preserving behavior.
 */

import type { AutoRetryController } from "../../agent/auto-retry.js";
import type { BashModeView } from "../bash-mode-view.js";
import type { CustomEditor } from "../custom-editor.js";
import type { InterruptController } from "../interrupt-controller.js";
import type { PasteHandler } from "../paste/paste-handler.js";
import type { PromptPayload } from "../prompt-queue.js";

export interface InputControllerDeps {
	editor: CustomEditor;
	getPasteHandler: () => PasteHandler;
	getBashModeView: () => BashModeView;
	getInterruptController: () => InterruptController;
	autoRetryController: AutoRetryController;
	consumeAttachments: (text: string) => PromptPayload;
}

export interface InputControllerCallbacks {
	showInfo: (message: string) => void;
	stopRenderer: () => void;
	exitProcess: (code?: number) => void;
}

export interface InputControllerOptions {
	deps: InputControllerDeps;
	callbacks: InputControllerCallbacks;
}

export class InputController {
	private readonly deps: InputControllerDeps;
	private readonly callbacks: InputControllerCallbacks;
	private onInputCallback?: (payload: PromptPayload) => void;
	private onInterruptCallback?: (options?: { keepPartial?: boolean }) => void;

	constructor(options: InputControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	async getUserInput(): Promise<PromptPayload> {
		return new Promise((resolve) => {
			this.onInputCallback = (payload: PromptPayload) => {
				this.onInputCallback = undefined;
				resolve(payload);
			};
		});
	}

	setInterruptCallback(
		callback: (options?: { keepPartial?: boolean }) => void,
	): void {
		this.onInterruptCallback = callback;
	}

	notifyInterrupt(options?: { keepPartial?: boolean }): void {
		this.onInterruptCallback?.(options);
	}

	async handleTextSubmit(text: string): Promise<void> {
		const payload = await this.prepareQueuedPayload(text);
		if (!payload) {
			return;
		}
		if (this.onInputCallback) {
			this.onInputCallback(payload);
		}
	}

	async handleFollowUpSubmit(text: string): Promise<boolean> {
		const payload = await this.prepareQueuedPayload(text);
		if (!payload) {
			return false;
		}
		payload.kind = "followUp";
		if (this.onInputCallback) {
			this.onInputCallback(payload);
		}
		return true;
	}

	handleInterruptRequest(): void {
		if (this.deps.autoRetryController.isRetrying()) {
			this.deps.autoRetryController.abortRetry();
		}
		this.deps.getInterruptController().handleInterruptRequest();
	}

	handleKeepPartialRequest(): boolean {
		return this.deps.getInterruptController().handleKeepPartialRequest();
	}

	interruptNow(options?: { keepPartial?: boolean }): void {
		if (this.deps.autoRetryController.isRetrying()) {
			this.deps.autoRetryController.abortRetry();
		}
		this.onInterruptCallback?.(options);
	}

	handleCtrlDExit(): void {
		this.callbacks.stopRenderer();
		this.callbacks.exitProcess(0);
	}

	async prepareQueuedPayload(text: string): Promise<PromptPayload | null> {
		const payload = await this.preparePayload(text);
		if (!payload) {
			return null;
		}
		const hasText = payload.text.trim().length > 0;
		if (hasText) {
			this.deps.editor.addToHistory(payload.text);
		}
		return payload;
	}

	private async preparePayload(text: string): Promise<PromptPayload | null> {
		const pasteHandler = this.deps.getPasteHandler();
		if (pasteHandler.hasPending()) {
			this.callbacks.showInfo(
				"Still summarizing pasted content — please wait a moment.",
			);
			return null;
		}
		const bashModeView = this.deps.getBashModeView();
		if (await bashModeView.tryHandleOneOffInput(text)) {
			return null;
		}
		if (await bashModeView.tryHandleInput(text)) {
			return null;
		}
		const payload = this.deps.consumeAttachments(text);
		const hasText = payload.text.trim().length > 0;
		const hasAttachments = (payload.attachments?.length ?? 0) > 0;
		if (!hasText && !hasAttachments) {
			return null;
		}
		return payload;
	}
}

export function createInputController(
	options: InputControllerOptions,
): InputController {
	return new InputController(options);
}
