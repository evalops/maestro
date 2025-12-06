/**
 * Native TUI Module
 *
 * Provides integration with the Rust-based TUI renderer for
 * improved SSH compatibility and terminal scrollback support.
 */

export { NativeTuiLauncher } from "./launcher.js";
export type { NativeTuiEvents } from "./launcher.js";

export { NativeTuiBridge, createNativeTuiBridge } from "./bridge.js";
export type { NativeTuiBridgeOptions } from "./bridge.js";

export * from "./protocol.js";

export {
	parseAnsiLine,
	lineToHistoryLine,
	linesToHistory,
	componentToRenderNode,
	linesToRenderNode,
	text,
	styledText,
	column,
	row,
	box,
	scroll,
	input,
	editor,
	spacer,
	empty,
} from "./adapter.js";

export { keyToAnsi, parseKeyName, isPrintable } from "./input-handler.js";
