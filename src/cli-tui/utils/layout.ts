/**
 * Layout constraints for TUI components.
 *
 * Centralizes all width-related magic numbers to make them:
 * 1. Discoverable and documented
 * 2. Responsive to terminal size where appropriate
 * 3. Consistent across components
 */

/**
 * Default panel widths used across the TUI.
 */
export const PANEL_WIDTHS = {
	/** Tool execution panels (bash, read, write, etc.) */
	tool: 60,

	/** User message cards - min/max for responsive sizing */
	userMessage: {
		min: 36,
		max: 72,
	},

	/** Welcome animation canvas */
	welcome: 56,

	/** About view decorative panel */
	about: 60,

	/** Shell block panels */
	shellBlock: {
		min: 42,
		max: 80,
	},

	/** Mermaid diagram containers */
	mermaid: {
		footer: 32,
	},

	/** Table column max width */
	tableColumn: 40,
} as const;

/**
 * Content display limits.
 */
export const DISPLAY_LIMITS = {
	/** Max visible items in selector lists */
	selectorItems: 10,

	/** Max visible lines in streaming output */
	streamingOutputLines: 20,

	/** Max visible items in context view */
	contextItems: 15,

	/** Max characters for inline code preview */
	inlineCodePreview: 100,
} as const;

/**
 * Padding and spacing constants.
 */
export const SPACING = {
	/** Standard horizontal padding (left/right) */
	paddingX: 1,

	/** Standard vertical padding (top/bottom) */
	paddingY: 1,

	/** Indent for nested content */
	indent: 2,

	/** Code block indent */
	codeIndent: 2,
} as const;

/**
 * Calculate responsive width within min/max bounds.
 */
export function responsiveWidth(
	terminalWidth: number,
	min: number,
	max: number,
	preferredRatio = 0.8,
): number {
	const preferred = Math.floor(terminalWidth * preferredRatio);
	return Math.min(max, Math.max(min, preferred));
}

/**
 * Calculate available content width after accounting for borders and padding.
 */
export function contentWidth(
	totalWidth: number,
	options: {
		borders?: boolean;
		paddingX?: number;
	} = {},
): number {
	const { borders = true, paddingX = SPACING.paddingX } = options;
	const borderWidth = borders ? 4 : 0; // "│ " on each side
	return Math.max(1, totalWidth - borderWidth - paddingX * 2);
}

/**
 * Type-safe getter for panel widths.
 */
export function getPanelWidth(
	panel: keyof typeof PANEL_WIDTHS,
): (typeof PANEL_WIDTHS)[typeof panel] {
	return PANEL_WIDTHS[panel];
}
