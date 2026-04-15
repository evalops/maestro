import { describe, expect, it, vi } from "vitest";
import { EditorView } from "../../src/cli-tui/editor-view.js";

type MockEditor = {
	getText: ReturnType<typeof vi.fn>;
	setText: ReturnType<typeof vi.fn>;
	insertText: ReturnType<typeof vi.fn>;
	onTab?: () => boolean;
	onEscape?: () => void;
	onCtrlC?: () => void;
	onCtrlD?: () => void;
	onShortcut?: (shortcut: string) => boolean;
	onSubmit?: (text: string) => void;
	onFollowUp?: () => void;
};

function createEditor(text: string, onTab?: () => boolean): MockEditor {
	return {
		getText: vi.fn().mockReturnValue(text),
		setText: vi.fn(),
		insertText: vi.fn(),
		onTab,
	};
}

describe("EditorView", () => {
	it("submits on Tab while idle when slash cycling does not handle the key", () => {
		const editor = createEditor("send draft", vi.fn().mockReturnValue(false));
		const onSubmit = vi.fn();
		const onFirstInput = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput,
			onSubmit,
			shouldFollowUp: () => false,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(true);
		expect(onFirstInput).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("send draft");
	});

	it("queues a follow-up on Tab while running when slash cycling does not handle it", () => {
		const editor = createEditor(
			"follow-up draft",
			vi.fn().mockReturnValue(false),
		);
		const onFollowUp = vi.fn();
		const onFirstInput = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput,
			onSubmit: vi.fn(),
			onFollowUp,
			shouldFollowUp: () => true,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(true);
		expect(onFirstInput).toHaveBeenCalledOnce();
		expect(onFollowUp).toHaveBeenCalledWith("follow-up draft");
	});

	it("preserves the existing Tab handler when slash cycling consumes the key", () => {
		const previousOnTab = vi.fn().mockReturnValue(true);
		const editor = createEditor("follow-up draft", previousOnTab);
		const onFollowUp = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit: vi.fn(),
			onFollowUp,
			shouldFollowUp: () => true,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(true);
		expect(previousOnTab).toHaveBeenCalledOnce();
		expect(onFollowUp).not.toHaveBeenCalled();
	});

	it("does not queue slash-command drafts on Tab while running", () => {
		const editor = createEditor("/help", vi.fn().mockReturnValue(false));
		const onFollowUp = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit: vi.fn(),
			onFollowUp,
			shouldFollowUp: () => true,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(false);
		expect(onFollowUp).not.toHaveBeenCalled();
	});

	it("does not queue shell-command drafts on Tab while running", () => {
		const editor = createEditor("!ls", vi.fn().mockReturnValue(false));
		const onFollowUp = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit: vi.fn(),
			onFollowUp,
			shouldFollowUp: () => true,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(true);
		expect(onFollowUp).not.toHaveBeenCalled();
	});

	it("does not submit shell-command drafts on Tab while idle", () => {
		const editor = createEditor("!ls", vi.fn().mockReturnValue(false));
		const onSubmit = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit,
			shouldFollowUp: () => false,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		expect(editor.onTab?.()).toBe(true);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("treats Alt+Enter on shell-command drafts as a newline instead of a queued follow-up", () => {
		const editor = createEditor("!ls");
		const onFollowUp = vi.fn();

		new EditorView({
			editor: editor as never,
			getCommandEntries: () => [],
			onFirstInput: vi.fn(),
			onSubmit: vi.fn(),
			onFollowUp,
			shouldFollowUp: () => true,
			shouldInterrupt: () => false,
			showCommandPalette: vi.fn(),
			showFileSearch: vi.fn(),
		});

		editor.onFollowUp?.();

		expect(editor.insertText).toHaveBeenCalledWith("\n");
		expect(onFollowUp).not.toHaveBeenCalled();
	});
});
