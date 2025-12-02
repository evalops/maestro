import chalk from "chalk";
import type { AutocompleteProvider } from "../autocomplete.js";
import type { Component } from "../tui.js";
import { SelectList, type SelectListTheme } from "./select-list.js";

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface LargePasteEvent {
	pasteId: number;
	content: string;
	lineCount: number;
	charCount: number;
	marker: string;
}

export type TextEditorConfig = Record<string, unknown> & {
	placeholder?: string;
};

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface HistoryEntry {
	state: EditorState;
	timestamp: number;
}

export class Editor implements Component {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};
	private config: TextEditorConfig = {};
	public placeholder?: string;
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private isAutocompleting = false;
	private autocompletePrefix = "";
	private pastes = new Map<number, string>();
	private pasteCounter = 0;
	private pasteMarkers = new Map<number, string>();
	private pasteReplacements = new Map<number, string>();
	private pasteBuffer = "";
	private isInPaste = false;
	private largePasteMode: "placeholder" | "verbatim" = "placeholder";
	private burstPasteTimer: NodeJS.Timeout | null = null;
	private burstPasteBuffer = "";

	// Undo/redo history
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];
	private static readonly MAX_HISTORY = 100;
	private lastSaveTime = 0;
	private static readonly SAVE_DEBOUNCE_MS = 300;

	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	onLargePaste?: (event: LargePasteEvent) => void;
	disableSubmit = false;

	constructor(config?: TextEditorConfig) {
		if (config) {
			this.config = { ...this.config, ...config };
			if (config.placeholder) {
				this.placeholder = config.placeholder;
			}
		}
	}
	configure(config: Partial<TextEditorConfig>): void {
		this.config = { ...this.config, ...config };
		if (config.placeholder) {
			this.placeholder = config.placeholder;
		}
	}
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
	}
	render(width: number, options: { hideBorders?: boolean } = {}): string[] {
		const horizontal = chalk.gray("─");
		// Layout the text - use full width
		const layoutLines = this.layoutText(width);
		const result = [];
		// Render top border
		if (!options.hideBorders) {
			result.push(horizontal.repeat(width));
		}
		// Render each layout line
		for (const layoutLine of layoutLines) {
			let displayText = layoutLine.text;
			let visibleLength = layoutLine.text.length;

			// Apply placeholder styling if needed
			if (layoutLine.isPlaceholder) {
				displayText = chalk.gray(displayText);
			}

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = layoutLine.text.slice(0, layoutLine.cursorPos);
				const after = layoutLine.text.slice(layoutLine.cursorPos);

				// Re-construct display text with cursor logic
				// Note: complex if placeholder is already colored, but placeholder usually doesn't have cursor in middle
				// For placeholder, cursor is usually at 0.

				if (layoutLine.isPlaceholder) {
					// Cursor at 0 for placeholder
					if (after.length > 0) {
						const cursor = `\x1b[7m${after[0]}\x1b[0m`;
						const restAfter = after.slice(1);
						// We need to apply gray to non-cursor parts
						displayText = chalk.gray(before) + cursor + chalk.gray(restAfter);
					} else {
						// Empty placeholder? Should not happen if text present
						const cursor = "\x1b[7m \x1b[0m";
						displayText = before + cursor;
					}
				} else {
					if (after.length > 0) {
						// Cursor is on a character - replace it with highlighted version
						const cursor = `\x1b[7m${after[0]}\x1b[0m`;
						const restAfter = after.slice(1);
						displayText = before + cursor + restAfter;
						// visibleLength stays the same - we're replacing, not adding
					} else {
						// Cursor is at the end - check if we have room for the space
						if (layoutLine.text.length < width) {
							// We have room - add highlighted space
							const cursor = "\x1b[7m \x1b[0m";
							displayText = before + cursor;
							// visibleLength increases by 1 - we're adding a space
							visibleLength = layoutLine.text.length + 1;
						} else {
							// Line is at full width - use reverse video on last character if possible
							// or just show cursor at the end without adding space
							if (before.length > 0) {
								const lastChar = before[before.length - 1];
								const cursor = `\x1b[7m${lastChar}\x1b[0m`;
								displayText = before.slice(0, -1) + cursor;
							}
							// visibleLength stays the same
						}
					}
				}
			}
			// Calculate padding based on actual visible length
			const padding = " ".repeat(Math.max(0, width - visibleLength));
			// Render the line (no side borders, just horizontal lines above and below if not hidden)
			result.push(displayText + padding);
		}
		// Render bottom border
		if (!options.hideBorders) {
			result.push(horizontal.repeat(width));
		}
		// Add autocomplete list if active
		if (this.isAutocompleting && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(width);
			result.push(...autocompleteResult);
		}
		return result;
	}
	handleInput(inputData: string): void {
		// Treat multi-character blobs arriving in raw mode as a paste burst when
		// bracketed paste isn't available (common over SSH/tmux). We debounce
		// for a few ms to avoid interleaving with streamed output.
		if (this.maybeHandleBurstPaste(inputData)) {
			return;
		}

		let data = this.normalizeArrowInput(inputData);
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~
		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			// Remove the start marker and keep the rest
			data = data.replace("\x1b[200~", "");
		}
		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Append data to buffer first (end marker could be split across chunks)
			this.pasteBuffer += data;
			// Check if the accumulated buffer contains the end marker
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract content before the end marker
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				// Process the complete paste
				this.handlePaste(pasteContent);
				// Reset paste state
				this.isInPaste = false;
				// Process any remaining data after the end marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			// Still accumulating, wait for more data
			return;
		}
		// Handle special key combinations first
		// Ctrl+C - Exit (let parent handle this)
		if (data.charCodeAt(0) === 3) {
			return;
		}
		// Handle autocomplete special keys first (but don't block other input)
		if (this.isAutocompleting && this.autocompleteList) {
			// Escape - cancel autocomplete
			if (data === "\x1b") {
				this.cancelAutocomplete();
				return;
			}
			// Let the autocomplete list handle navigation and selection
			if (
				data === "\x1b[A" ||
				data === "\x1b[B" ||
				data === "\r" ||
				data === "\t"
			) {
				// Only pass arrow keys to the list, not Enter/Tab (we handle those directly)
				if (data === "\x1b[A" || data === "\x1b[B") {
					this.autocompleteList.handleInput(data);
					return;
				}
				// If Tab or Enter was pressed, apply the selection
				if (data === "\t" || data === "\r") {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						const result = this.autocompleteProvider.applyCompletion(
							this.state.lines,
							this.state.cursorLine,
							this.state.cursorCol,
							selected,
							this.autocompletePrefix,
						);
						this.state.lines = result.lines;
						this.state.cursorLine = result.cursorLine;
						this.state.cursorCol = result.cursorCol;
						this.cancelAutocomplete();
						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}
				// For other keys, handle normally within autocomplete
				return;
			}
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}
		// Tab key - context-aware completion (but not when already autocompleting)
		if (data === "\t" && !this.isAutocompleting) {
			this.handleTabCompletion();
			return;
		}
		// Continue with rest of input handling
		// Ctrl+Z - Undo
		if (data.charCodeAt(0) === 26) {
			this.undo();
			return;
		}
		// Ctrl+Y or Ctrl+Shift+Z - Redo (some terminals send \x19 for Ctrl+Y)
		if (data.charCodeAt(0) === 25) {
			this.redo();
			return;
		}
		// Ctrl+K - Delete to end of line (or merge with next line if at end)
		if (data.charCodeAt(0) === 11) {
			this.deleteToEndOfLine();
		}
		// Ctrl+U - Delete to start of line (or merge with previous line if at start)
		else if (data.charCodeAt(0) === 21) {
			this.deleteToStartOfLine();
		}
		// Ctrl+W - Delete word backwards
		else if (data.charCodeAt(0) === 23) {
			this.deleteWordBackwards();
		}
		// Option/Alt+Backspace (e.g. Ghostty sends ESC + DEL)
		else if (data === "\x1b\x7f") {
			this.deleteWordBackwards();
		}
		// Ctrl+A - Move to start of line
		else if (data.charCodeAt(0) === 1) {
			this.moveToLineStart();
		}
		// Ctrl+E - Move to end of line
		else if (data.charCodeAt(0) === 5) {
			this.moveToLineEnd();
		}
		// New line shortcuts (but not plain LF/CR which should be submit)
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
			data === "\x1b\r" || // Option+Enter in some terminals
			data === "\x1b[13;2~" || // Shift+Enter in some terminals
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1) || // Shift+Enter from iTerm2 mapping
			data === "\\\r" // Shift+Enter in VS Code terminal
		) {
			// Modifier + Enter = new line
			this.addNewLine();
		}
		// Plain Enter (char code 13 for CR) - only CR submits, LF adds new line
		else if (data.charCodeAt(0) === 13 && data.length === 1) {
			// If submit is disabled, do nothing
			if (this.disableSubmit) {
				return;
			}
			// Get text and substitute paste markers with actual content
			let result = this.state.lines.join("\n").trim();
			// Replace all [paste #N +xxx lines] or [paste #N xxx chars] markers with actual paste content
			for (const [pasteId, pasteContent] of this.pastes) {
				// Match formats: [paste #N], [paste #N +xxx lines], or [paste #N xxx chars]
				const markerRegex = new RegExp(
					`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`,
					"g",
				);
				const replacement = this.pasteReplacements.get(pasteId) ?? pasteContent;
				result = result.replace(markerRegex, replacement);
			}
			// Reset editor and clear pastes
			this.state = {
				lines: [""],
				cursorLine: 0,
				cursorCol: 0,
			};
			this.pastes.clear();
			this.pasteMarkers.clear();
			this.pasteReplacements.clear();
			this.pasteCounter = 0;
			// Notify that editor is now empty
			if (this.onChange) {
				this.onChange("");
			}
			if (this.onSubmit) {
				this.onSubmit(result);
			}
		}
		// Backspace
		else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
			this.handleBackspace();
		}
		// Line navigation shortcuts (Home/End keys)
		else if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1b[7~") {
			// Home key
			this.moveToLineStart();
		} else if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1b[8~") {
			// End key
			this.moveToLineEnd();
		}
		// Forward delete (Fn+Backspace or Delete key)
		else if (data === "\x1b[3~") {
			// Delete key
			this.handleForwardDelete();
		}
		// Arrow keys
		else if (data === "\x1b[A") {
			// Up
			this.moveCursor(-1, 0);
		} else if (data === "\x1b[B") {
			// Down
			this.moveCursor(1, 0);
		} else if (data === "\x1b[C") {
			// Right
			this.moveCursor(0, 1);
		} else if (data === "\x1b[D") {
			// Left
			this.moveCursor(0, -1);
		}
		// Regular characters (printable ASCII)
		else if (data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
			this.insertCharacter(data);
		}
	}

	protected normalizeArrowInput(data: string): string {
		// Terminals in application-cursor mode emit SS3 sequences (e.g., ESC O A).
		// Normalize them so the editor treats them the same as CSI arrows.
		switch (data) {
			case "\x1bOA":
				return "\x1b[A";
			case "\x1bOB":
				return "\x1b[B";
			case "\x1bOC":
				return "\x1b[C";
			case "\x1bOD":
				return "\x1b[D";
			default:
				return data;
		}
	}
	private layoutText(contentWidth: number): Array<{
		text: string;
		hasCursor: boolean;
		cursorPos?: number;
		isPlaceholder?: boolean;
	}> {
		const layoutLines = [];
		if (
			this.state.lines.length === 0 ||
			(this.state.lines.length === 1 && this.state.lines[0] === "")
		) {
			// Empty editor
			if (this.placeholder) {
				layoutLines.push({
					text: this.placeholder,
					hasCursor: true,
					cursorPos: 0,
					isPlaceholder: true,
				});
			} else {
				layoutLines.push({
					text: "",
					hasCursor: true,
					cursorPos: 0,
				});
			}
			return layoutLines;
		}
		// Process each logical line
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			const maxLineLength = contentWidth;
			if (line.length <= maxLineLength) {
				// Line fits in one layout line
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				// Line needs wrapping
				const chunks = [];
				for (let pos = 0; pos < line.length; pos += maxLineLength) {
					chunks.push(line.slice(pos, pos + maxLineLength));
				}
				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;
					const chunkStart = chunkIndex * maxLineLength;
					const chunkEnd = chunkStart + chunk.length;
					const cursorPos = this.state.cursorCol;
					const hasCursorInChunk =
						isCurrentLine && cursorPos >= chunkStart && cursorPos <= chunkEnd;
					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk,
							hasCursor: true,
							cursorPos: cursorPos - chunkStart,
						});
					} else {
						layoutLines.push({
							text: chunk,
							hasCursor: false,
						});
					}
				}
			}
		}
		return layoutLines;
	}
	getText(): string {
		return this.state.lines.join("\n");
	}
	setText(text: string): void {
		// Split text into lines, handling different line endings
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		// Ensure at least one empty line
		this.state.lines = lines.length === 0 ? [""] : lines;
		// Reset cursor to end of text
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;
		// Notify of change
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private maybeHandleBurstPaste(data: string): boolean {
		// Ignore control characters and single key presses
		if (data.length <= 1) return false;
		// Ignore escape-driven control sequences (arrow keys, function keys, etc.)
		// so they are processed by the normal input handler.
		if (data.startsWith("\x1b")) return false;
		// If bracketed paste markers are present, let the main handler manage them.
		if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
			return false;
		}
		this.burstPasteBuffer += data;
		if (this.burstPasteTimer) {
			return true;
		}
		this.burstPasteTimer = setTimeout(() => {
			const content = this.burstPasteBuffer;
			this.burstPasteBuffer = "";
			this.burstPasteTimer = null;
			this.handlePaste(content);
		}, 12);
		return true;
	}
	// All the editor methods from before...
	setLargePasteMode(mode: "placeholder" | "verbatim"): void {
		this.largePasteMode = mode;
	}
	private insertCharacter(char: string): void {
		this.saveToHistory();
		const line = this.state.lines[this.state.cursorLine] || "";
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);
		this.state.lines[this.state.cursorLine] = before + char + after;
		this.state.cursorCol += char.length; // Fix: increment by the length of the inserted string
		if (this.onChange) {
			this.onChange(this.getText());
		}
		// Check if we should trigger or update autocomplete
		if (!this.isAutocompleting) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for "@" (mentions)
			else if (char === "@") {
				this.tryTriggerAutocomplete();
			}
			// Also auto-trigger when typing letters in a slash command context
			else if (/[a-zA-Z0-9]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command with a space (i.e., typing arguments)
				if (
					textBeforeCursor.startsWith("/") &&
					textBeforeCursor.includes(" ")
				) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	insertText(text: string): void {
		for (const char of text) {
			this.insertCharacter(char);
		}
	}
	setPasteReplacement(pasteId: number, replacement: string): void {
		this.pasteReplacements.set(pasteId, replacement);
	}
	replacePasteMarker(
		pasteId: number,
		replacementText: string,
		options?: { keepOriginal?: boolean },
	): boolean {
		const marker = this.pasteMarkers.get(pasteId);
		if (!marker) {
			return false;
		}
		const currentText = this.state.lines.join("\n");
		if (!currentText.includes(marker)) {
			return false;
		}
		const updated = currentText.replace(marker, replacementText);
		if (updated === currentText) {
			return false;
		}
		this.setText(updated);
		if (!options?.keepOriginal) {
			this.pastes.delete(pasteId);
			this.pasteMarkers.delete(pasteId);
			this.pasteReplacements.delete(pasteId);
		}
		return true;
	}
	private handlePaste(pastedText: string): void {
		this.saveToHistory();
		// Clean the pasted text
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		// Convert tabs to spaces (4 spaces per tab)
		const tabExpandedText = cleanText.replace(/\t/g, "    ");
		// Filter out non-printable characters except newlines
		const filteredText = tabExpandedText
			.split("")
			.filter((char) => char === "\n" || (char >= " " && char <= "~"))
			.join("");
		// Split into lines
		const pastedLines = filteredText.split("\n");
		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		const isLargePaste = pastedLines.length > 10 || totalChars > 1000;
		if (isLargePaste && this.largePasteMode === "placeholder") {
			// Store the paste and insert a marker
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);
			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.pasteMarkers.set(pasteId, marker);
			for (const char of marker) {
				this.insertCharacter(char);
			}
			this.onLargePaste?.({
				pasteId,
				content: filteredText,
				lineCount: pastedLines.length,
				charCount: totalChars,
				marker,
			});
			return;
		}
		if (pastedLines.length === 1) {
			// Single line - just insert each character
			const text = pastedLines[0] || "";
			for (const char of text) {
				this.insertCharacter(char);
			}
			return;
		}
		// Multi-line paste - be very careful with array manipulation
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);
		// Build the new lines array step by step
		const newLines = [];
		// Add all lines before current line
		for (let i = 0; i < this.state.cursorLine; i++) {
			newLines.push(this.state.lines[i] || "");
		}
		// Add the first pasted line merged with before cursor text
		newLines.push(beforeCursor + (pastedLines[0] || ""));
		// Add all middle pasted lines
		for (let i = 1; i < pastedLines.length - 1; i++) {
			newLines.push(pastedLines[i] || "");
		}
		// Add the last pasted line with after cursor text
		newLines.push((pastedLines[pastedLines.length - 1] || "") + afterCursor);
		// Add all lines after current line
		for (let i = this.state.cursorLine + 1; i < this.state.lines.length; i++) {
			newLines.push(this.state.lines[i] || "");
		}
		// Replace the entire lines array
		this.state.lines = newLines;
		// Update cursor position to end of pasted content
		this.state.cursorLine += pastedLines.length - 1;
		this.state.cursorCol = (pastedLines[pastedLines.length - 1] || "").length;
		// Notify of change
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}
	private addNewLine(): void {
		this.saveToHistory();
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);
		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);
		// Move cursor to start of new line
		this.state.cursorLine++;
		this.state.cursorCol = 0;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}
	private handleBackspace(): void {
		this.saveToHistory();
		if (this.state.cursorCol > 0) {
			// Delete character in current line
			const line = this.state.lines[this.state.cursorLine] || "";
			const before = line.slice(0, this.state.cursorCol - 1);
			const after = line.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.state.cursorCol--;
		} else if (this.state.cursorLine > 0) {
			// Merge with previous line
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
		// Update autocomplete after backspace
		if (this.isAutocompleting) {
			this.updateAutocomplete();
		}
	}
	private moveToLineStart(): void {
		this.state.cursorCol = 0;
	}
	private moveToLineEnd(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.state.cursorCol = currentLine.length;
	}
	private handleForwardDelete(): void {
		this.saveToHistory();
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol < currentLine.length) {
			// Delete character at cursor position (forward delete)
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + 1);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToStartOfLine(): void {
		this.saveToHistory();
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol > 0) {
			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(
				this.state.cursorCol,
			);
			this.state.cursorCol = 0;
		} else if (this.state.cursorLine > 0) {
			// At start of line - merge with previous line
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.saveToHistory();
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol < currentLine.length) {
			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(
				0,
				this.state.cursorCol,
			);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.saveToHistory();
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] =
					previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.state.cursorCol = previousLine.length;
			}
		} else {
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			const isWhitespace = (char: string): boolean => /\s/.test(char);
			const isPunctuation = (char: string): boolean => {
				// Treat obvious code punctuation as boundaries
				return /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/.test(char);
			};
			let deleteFrom = this.state.cursorCol;

			// Match standard bash/zsh behavior:
			// 1. Skip all trailing whitespace/punctuation
			// 2. Then delete the entire word

			// First, skip backwards over any trailing whitespace/punctuation
			while (deleteFrom > 0) {
				const ch = textBeforeCursor[deleteFrom - 1] ?? "";
				if (!isWhitespace(ch) && !isPunctuation(ch)) {
					break;
				}
				deleteFrom -= 1;
			}

			// Then delete the word (run of non-boundary characters)
			while (deleteFrom > 0) {
				const ch = textBeforeCursor[deleteFrom - 1] ?? "";
				if (isWhitespace(ch) || isPunctuation(ch)) {
					break;
				}
				deleteFrom -= 1;
			}
			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) +
				currentLine.slice(this.state.cursorCol);
			this.state.cursorCol = deleteFrom;
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}
	private moveCursor(deltaLine: number, deltaCol: number): void {
		if (deltaLine !== 0) {
			const newLine = this.state.cursorLine + deltaLine;
			if (newLine >= 0 && newLine < this.state.lines.length) {
				this.state.cursorLine = newLine;
				// Clamp cursor column to new line length
				const line = this.state.lines[this.state.cursorLine] || "";
				this.state.cursorCol = Math.min(this.state.cursorCol, line.length);
			}
		}
		if (deltaCol !== 0) {
			// Move column
			const newCol = this.state.cursorCol + deltaCol;
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const maxCol = currentLine.length;
			this.state.cursorCol = Math.max(0, Math.min(maxCol, newCol));
		}
	}
	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		// At start if line is empty, only contains whitespace, or is just "/"
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}
	// Autocomplete methods
	tryTriggerAutocomplete(explicitTab = false) {
		if (!this.autocompleteProvider) return;
		// Check if we should trigger file completion on Tab
		if (explicitTab) {
			const provider = this.autocompleteProvider;
			const shouldTrigger =
				!("shouldTriggerFileCompletion" in provider) ||
				(provider as any).shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}
		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);
		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5);
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}
	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		// Check if we're in a slash command context
		if (beforeCursor.trimStart().startsWith("/")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete();
		}
	}
	private handleSlashCommandCompletion(): void {
		// For now, fall back to regular autocomplete (slash commands)
		// This can be extended later to handle command-specific argument completion
		this.tryTriggerAutocomplete(true);
	}
	private forceFileAutocomplete(): void {
		if (!this.autocompleteProvider) return;
		// Check if provider has the force method
		const provider = this.autocompleteProvider;
		if (!("getForceFileSuggestions" in provider)) {
			this.tryTriggerAutocomplete(true);
			return;
		}
		const suggestions = (provider as any).getForceFileSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);
		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5);
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}
	private cancelAutocomplete(): void {
		this.isAutocompleting = false;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}
	isShowingAutocomplete(): boolean {
		return this.isAutocompleting;
	}
	private updateAutocomplete(): void {
		if (!this.isAutocompleting || !this.autocompleteProvider) return;
		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);
		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			if (this.autocompleteList) {
				// Update the existing list with new items
				this.autocompleteList = new SelectList(suggestions.items, 5);
			}
		} else {
			// No more matches, cancel autocomplete
			this.cancelAutocomplete();
		}
	}

	/**
	 * Save current state to undo history.
	 * Debounces saves to avoid excessive history entries during rapid typing.
	 */
	private saveToHistory(): void {
		const now = Date.now();
		if (now - this.lastSaveTime < Editor.SAVE_DEBOUNCE_MS) {
			// Update the most recent entry instead of creating a new one
			if (this.undoStack.length > 0) {
				this.undoStack[this.undoStack.length - 1] = {
					state: this.cloneState(),
					timestamp: now,
				};
			}
			return;
		}

		this.undoStack.push({
			state: this.cloneState(),
			timestamp: now,
		});

		// Trim history if too long
		if (this.undoStack.length > Editor.MAX_HISTORY) {
			this.undoStack.shift();
		}

		// Clear redo stack when new changes are made
		this.redoStack = [];
		this.lastSaveTime = now;
	}

	/**
	 * Clone current editor state.
	 */
	private cloneState(): EditorState {
		return {
			lines: [...this.state.lines],
			cursorLine: this.state.cursorLine,
			cursorCol: this.state.cursorCol,
		};
	}

	/**
	 * Undo the last change.
	 */
	undo(): boolean {
		if (this.undoStack.length === 0) {
			return false;
		}

		// Save current state to redo stack
		this.redoStack.push({
			state: this.cloneState(),
			timestamp: Date.now(),
		});

		// Restore previous state
		const entry = this.undoStack.pop();
		if (entry) {
			this.state = {
				lines: [...entry.state.lines],
				cursorLine: entry.state.cursorLine,
				cursorCol: entry.state.cursorCol,
			};
			if (this.onChange) {
				this.onChange(this.getText());
			}
			return true;
		}
		return false;
	}

	/**
	 * Redo the last undone change.
	 */
	redo(): boolean {
		if (this.redoStack.length === 0) {
			return false;
		}

		// Save current state to undo stack
		this.undoStack.push({
			state: this.cloneState(),
			timestamp: Date.now(),
		});

		// Restore next state
		const entry = this.redoStack.pop();
		if (entry) {
			this.state = {
				lines: [...entry.state.lines],
				cursorLine: entry.state.cursorLine,
				cursorCol: entry.state.cursorCol,
			};
			if (this.onChange) {
				this.onChange(this.getText());
			}
			return true;
		}
		return false;
	}

	/**
	 * Clear undo/redo history.
	 */
	clearHistory(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.lastSaveTime = 0;
	}

	/**
	 * Check if undo is available.
	 */
	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	/**
	 * Check if redo is available.
	 */
	canRedo(): boolean {
		return this.redoStack.length > 0;
	}
}
