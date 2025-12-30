/**
 * @fileoverview @evalops/tui - Terminal UI Library
 *
 * A high-performance terminal UI library featuring differential rendering
 * for building flicker-free, interactive CLI applications.
 *
 * ## Key Features
 *
 * - **Differential Rendering**: Only redraws changed lines for optimal performance
 * - **Component-Based**: Simple `Component` interface with `render()` method
 * - **Built-in Components**: Text, Input, Editor, Loader, SelectList, Markdown, and more
 * - **ANSI Support**: Full color and formatting via terminal escape sequences
 * - **Keyboard Handling**: Arrow keys, home/end, Ctrl shortcuts, focus management
 * - **Smart Text Wrapping**: Proper handling of ANSI escape sequences and Unicode
 * - **SSH/tmux Optimizations**: Auto-detects remote sessions and adjusts behavior
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                         TUI (Container)                         │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
 * │  │    Text     │  │   Editor    │  │  SelectList │  ...        │
 * │  │ (Component) │  │ (Component) │  │ (Component) │             │
 * │  └─────────────┘  └─────────────┘  └─────────────┘             │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                    Differential Renderer                        │
 * │        (compares previous/current, updates only changes)        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                    Terminal Abstraction                         │
 * │              (ProcessTerminal or custom impl)                   │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Quick Start
 *
 * ```typescript
 * import { TUI, ProcessTerminal, Text, Input } from "@evalops/tui";
 *
 * const tui = new TUI(new ProcessTerminal());
 *
 * // Add components
 * tui.addChild(new Text("Welcome to my app!"));
 *
 * const input = new Input();
 * input.onSubmit = (text) => console.log("You entered:", text);
 * tui.addChild(input);
 *
 * // Set focus and start
 * tui.setFocus(input);
 * tui.start();
 * ```
 *
 * ## Component Interface
 *
 * All components implement the `Component` interface:
 *
 * ```typescript
 * interface Component {
 *   render(width: number): string[];     // Return lines to display
 *   handleInput?(data: string): void;    // Optional keyboard handling
 * }
 * ```
 *
 * @module @evalops/tui
 */
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
	type CommandArgumentDefinition,
	type CommandArgumentType,
} from "./autocomplete.js";
export { Editor } from "./components/editor.js";
export type { LargePasteEvent } from "./components/editor.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export { Markdown, type MarkdownTheme } from "./components/markdown.js";
export { StatusBar } from "./components/status-bar.js";
export {
	type SelectItem,
	SelectList,
	type SelectListTheme,
} from "./components/select-list.js";
export type { EditorTheme } from "./components/editor.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { TruncatedText } from "./components/truncated-text.js";
export {
	Box,
	type BaseLayoutOptions,
	type BoxOptions,
	Column,
	type RowOptions,
	Row,
} from "./components/layout.js";
export {
	ScrollContainer,
	type ScrollContainerOptions,
} from "./components/scroll-container.js";
export { ProcessTerminal, type Terminal } from "./terminal.js";
export {
	type Component,
	type LifecycleComponent,
	type RenderPath,
	type RenderStats,
	Container,
	TUI,
} from "./tui.js";
export {
	truncateToWidth,
	visibleWidth,
	wrapAnsiLine,
	wrapAnsiLines,
} from "./utils.js";
export { detectTerminalFeatures } from "./utils/terminal-features.js";
export {
	AnsiKeys,
	ControlCodes,
	ctrl,
	isAltBackspace,
	isAltEnter,
	isCtrlA,
	isCtrlC,
	isCtrlD,
	isCtrlE,
	isCtrlK,
	isCtrlO,
	isCtrlP,
	isCtrlT,
	isCtrlU,
	isCtrlW,
	isShiftEnter,
	isShiftTab,
	Keymap,
	KittyKeys,
	type KeyBinding,
} from "./keymap.js";
