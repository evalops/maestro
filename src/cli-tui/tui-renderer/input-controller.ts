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

export interface InputControllerDeps {
	editor: CustomEditor;
	getPasteHandler: () => PasteHandler;
	getBashModeView: () => BashModeView;
	getInterruptController: () => InterruptController;
	autoRetryController: AutoRetryController;
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
	private onInputCallback?: (text: string) => void;
	private onInterruptCallback?: (options?: { keepPartial?: boolean }) => void;

	constructor(options: InputControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
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
		const pasteHandler = this.deps.getPasteHandler();
		if (pasteHandler.hasPending()) {
			this.callbacks.showInfo(
				"Still summarizing pasted content — please wait a moment.",
			);
			return;
		}
		const bashModeView = this.deps.getBashModeView();
		if (await bashModeView.tryHandleInput(text)) {
			return;
		}
		if (text.trim()) {
			this.deps.editor.addToHistory(text);
		}
		if (this.onInputCallback) {
			this.onInputCallback(text);
		}
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

	handleCtrlDExit(): void {
		this.callbacks.stopRenderer();
		this.callbacks.exitProcess(0);
	}
}

export function createInputController(
	options: InputControllerOptions,
): InputController {
	return new InputController(options);
}
