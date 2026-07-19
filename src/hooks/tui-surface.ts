/**
 * Structural terminal-UI surface types for the public hooks API.
 *
 * User hook scripts may reference `Component` / `TUI` via the hooks types
 * module. These are intentionally structural (not imported from the terminal
 * UI package) so hooks types and non-interactive hook runners never take a
 * hard dependency on that package. The interactive TUI implementation remains
 * structurally assignable to these contracts.
 */

/**
 * Minimal renderable component surface (matches the terminal UI Component
 * interface enough for hook custom UI factories and message renderers).
 */
export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	onMount?(): void;
	onUnmount?(): void;
	dispose?(): void;
}

/**
 * Minimal TUI host surface passed to hook `ui.custom()` factories.
 * Only the methods hooks commonly need are declared; extra methods on the
 * real host are fine (structural typing).
 */
export interface TUI {
	addChild(component: Component): void;
	removeChild?(component: Component): void;
	setFocus(component: Component | null): void;
	requestRender?(priority?: "normal" | "interactive"): void;
	start?(): void;
	stop?(): void;
}
