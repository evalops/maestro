/**
 * @evalops/tui - Terminal UI Library
 *
 * Extracted from Composer CLI for reusability.
 * Components for building interactive terminal applications.
 */

// Core types
export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
}

export interface Terminal {
	width: number;
	height: number;
	write(data: string): void;
	on(event: string, callback: (...args: any[]) => void): void;
	removeListener(event: string, callback: (...args: any[]) => void): void;
}

// Re-export main TUI class (to be implemented)
// export { TUI } from "./tui.js";

// Re-export components (to be implemented)
// export { Text } from "./components/text.js";
// export { Input } from "./components/input.js";
// export { Editor } from "./components/editor.js";
// export { Loader } from "./components/loader.js";
// export { SelectList } from "./components/select-list.js";
// export { Spacer } from "./components/spacer.js";
// export { Container } from "./components/container.js";
