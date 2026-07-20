import type { LargePasteEvent, ScrollContainer, TUI } from "@evalops/tui";
import type { CustomEditor } from "../custom-editor.js";

export interface EditorBindingHandlers {
	handleLargePaste: (event: LargePasteEvent) => void | Promise<void>;
	handlePasteImage: () => void | Promise<void>;
	handleTyping: () => void;
	cycleModel: () => void | Promise<void>;
	toggleToolOutputs: () => void;
	toggleThinkingBlocks: () => void;
	openExternalEditor: () => void;
	suspend: () => void;
	handleSlashCycle: (reverse: boolean) => boolean;
	cycleThinkingLevel: () => void;
}

export function attachEditorBindings(params: {
	editor: CustomEditor;
	scrollContainer: ScrollContainer;
	ui: TUI;
	handlers: EditorBindingHandlers;
}): void {
	const { editor, scrollContainer, ui, handlers } = params;

	editor.onLargePaste = (event) => {
		void handlers.handleLargePaste(event);
	};
	editor.onPasteImage = () => {
		void handlers.handlePasteImage();
	};
	editor.onTyping = () => {
		handlers.handleTyping();
	};
	editor.onCtrlP = () => {
		void handlers.cycleModel();
	};
	editor.onCtrlO = () => {
		handlers.toggleToolOutputs();
	};
	editor.onCtrlT = () => {
		handlers.toggleThinkingBlocks();
	};
	editor.onCtrlG = () => {
		handlers.openExternalEditor();
	};
	editor.onCtrlZ = () => {
		handlers.suspend();
	};
	editor.onTab = () => handlers.handleSlashCycle(false);
	editor.onShiftTab = () => {
		const handled = handlers.handleSlashCycle(true);
		if (handled) return true;
		handlers.cycleThinkingLevel();
		return true;
	};

	editor.onShortcut = (shortcut: string) => {
		switch (shortcut) {
			case "pageup":
				scrollContainer.pageUp();
				ui.requestRender();
				return true;
			case "pagedown":
				scrollContainer.pageDown();
				ui.requestRender();
				return true;
			case "ctrl+u":
				scrollContainer.halfPageUp();
				ui.requestRender();
				return true;
			case "ctrl+d":
				scrollContainer.halfPageDown();
				ui.requestRender();
				return true;
			case "ctrl+home":
				scrollContainer.scrollToTop();
				ui.requestRender();
				return true;
			case "ctrl+end":
				scrollContainer.scrollToBottom();
				ui.requestRender();
				return true;
			default:
				return false;
		}
	};

	editor.onHistoryNavigate = (direction) => {
		const dir = direction === "prev" ? -1 : 1;
		if (editor.isEditorEmpty()) {
			return editor.navigatePromptHistory(dir);
		}
		if (editor.isBrowsingHistory()) {
			return editor.navigatePromptHistory(dir);
		}
		return false;
	};
}
