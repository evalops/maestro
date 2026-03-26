/**
 * Centralized UI Glyphs - Claude Code-inspired iconography
 *
 * This module provides all Unicode glyphs used across the TUI with
 * automatic ASCII fallbacks for low-unicode terminals.
 *
 * Design Philosophy:
 * - Geometric shapes for tools (purposeful, minimal)
 * - Semantic indicators for status (intuitive meaning)
 * - Consistent visual language throughout
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Environment Detection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Check if the terminal supports Unicode.
 * Can be overridden via MAESTRO_LOW_UNICODE=1
 */
function detectLowUnicode(): boolean {
	const envOverride = process.env.MAESTRO_LOW_UNICODE;
	if (envOverride === "1" || envOverride === "true") return true;
	if (envOverride === "0" || envOverride === "false") return false;

	// Heuristics for low-unicode environments
	const term = process.env.TERM ?? "";
	const lang = process.env.LANG ?? "";

	// Windows cmd.exe and some legacy terminals
	if (term === "dumb" || term === "") return true;

	// Check for UTF-8 locale
	if (!lang.toLowerCase().includes("utf")) return true;

	return false;
}

let lowUnicodeMode: boolean | null = null;

/**
 * Get whether low-unicode mode is active (cached)
 */
export function isLowUnicode(): boolean {
	if (lowUnicodeMode === null) {
		lowUnicodeMode = detectLowUnicode();
	}
	return lowUnicodeMode;
}

/**
 * Force low-unicode mode on/off (for testing)
 */
export function setLowUnicode(value: boolean): void {
	lowUnicodeMode = value;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Glyph Sets
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Tool icon glyphs - geometric, purposeful */
const TOOL_ICONS_UNICODE = {
	bash: "⬢",
	edit: "✎",
	read: "◉",
	write: "◎",
	task: "◆",
	glob: "◇",
	grep: "⊙",
	webfetch: "⊕",
	websearch: "⊛",
	notebookedit: "▣",
	todowrite: "☑",
	default: "●",
} as const;

const TOOL_ICONS_ASCII = {
	bash: "$",
	edit: "~",
	read: ">",
	write: "+",
	task: "?",
	glob: "@",
	grep: "#",
	webfetch: "^",
	websearch: "*",
	notebookedit: "#",
	todowrite: "x",
	default: "*",
} as const;

/** Status indicator glyphs */
const STATUS_GLYPHS_UNICODE = {
	running: "◐",
	done: "●",
	success: "✓",
	error: "✕",
	waiting: "◑",
	pending: "○",
	info: "•",
} as const;

const STATUS_GLYPHS_ASCII = {
	running: "~",
	done: "*",
	success: "+",
	error: "x",
	waiting: "~",
	pending: "o",
	info: "-",
} as const;

/** Git status glyphs */
const GIT_GLYPHS_UNICODE = {
	clean: "○",
	dirty: "●",
	staged: "◐",
	ahead: "↑",
	behind: "↓",
	diverged: "↕",
	branch: "⎇",
} as const;

const GIT_GLYPHS_ASCII = {
	clean: "o",
	dirty: "*",
	staged: "~",
	ahead: "^",
	behind: "v",
	diverged: "!",
	branch: "*",
} as const;

/** Spinner frames for loading animations */
const SPINNER_FRAMES_UNICODE = {
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	dots: ["·  ", "·· ", "···", " ··", "  ·", "   "],
	pulse: ["◆", "◇", "◇", "◇"],
	arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
} as const;

const SPINNER_FRAMES_ASCII = {
	braille: ["-", "\\", "|", "/"],
	dots: [".", "..", "...", "..", "."],
	pulse: ["*", ".", ".", "."],
	arc: ["-", "\\", "|", "/"],
} as const;

/** Skeleton/loading shimmer frames */
const SKELETON_FRAMES_UNICODE = ["░", "▒", "▓", "▒"];
const SKELETON_FRAMES_ASCII = [".", "o", "O", "o"];

/** Progress bar character set */
interface ProgressChars {
	filled: string;
	empty: string;
	start: string;
	end: string;
}

const PROGRESS_UNICODE: ProgressChars = {
	filled: "━",
	empty: "─",
	start: "[",
	end: "]",
};

const PROGRESS_ASCII: ProgressChars = {
	filled: "=",
	empty: "-",
	start: "[",
	end: "]",
};

/** Separator/border character set */
interface SeparatorChars {
	vertical: string;
	horizontal: string;
	dot: string;
	bullet: string;
}

const SEPARATOR_UNICODE: SeparatorChars = {
	vertical: "│",
	horizontal: "─",
	dot: "·",
	bullet: "•",
};

const SEPARATOR_ASCII: SeparatorChars = {
	vertical: "|",
	horizontal: "-",
	dot: ".",
	bullet: "*",
};

/** Brand glyph */
const BRAND_GLYPH_UNICODE = "◆";
const BRAND_GLYPH_ASCII = "*";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public API - Auto-selects based on terminal capability
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ToolName = keyof typeof TOOL_ICONS_UNICODE;
export type StatusName = keyof typeof STATUS_GLYPHS_UNICODE;
export type GitStatusName = keyof typeof GIT_GLYPHS_UNICODE;
export type SpinnerStyle = keyof typeof SPINNER_FRAMES_UNICODE;

/**
 * Get the appropriate tool icon glyph
 */
export function toolIcon(name: string): string {
	const key = name.toLowerCase() as ToolName;
	const icons = isLowUnicode() ? TOOL_ICONS_ASCII : TOOL_ICONS_UNICODE;
	return icons[key] ?? icons.default;
}

/**
 * Get all tool icons (for iteration)
 */
export function allToolIcons(): Record<string, string> {
	return isLowUnicode() ? { ...TOOL_ICONS_ASCII } : { ...TOOL_ICONS_UNICODE };
}

/**
 * Get status indicator glyph
 */
export function statusGlyph(status: StatusName): string {
	const glyphs = isLowUnicode() ? STATUS_GLYPHS_ASCII : STATUS_GLYPHS_UNICODE;
	return glyphs[status];
}

/**
 * Get git status glyph
 */
export function gitGlyph(status: GitStatusName): string {
	const glyphs = isLowUnicode() ? GIT_GLYPHS_ASCII : GIT_GLYPHS_UNICODE;
	return glyphs[status];
}

/**
 * Get spinner frames for animation
 */
export function spinnerFrames(
	style: SpinnerStyle = "braille",
): readonly string[] {
	const frames = isLowUnicode() ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES_UNICODE;
	return frames[style];
}

/**
 * Get skeleton shimmer frames
 */
export function skeletonFrames(): readonly string[] {
	return isLowUnicode() ? SKELETON_FRAMES_ASCII : SKELETON_FRAMES_UNICODE;
}

/**
 * Get progress bar characters
 */
export function progressChars(): ProgressChars {
	return isLowUnicode() ? PROGRESS_ASCII : PROGRESS_UNICODE;
}

/**
 * Get separator/border characters
 */
export function separatorChars(): SeparatorChars {
	return isLowUnicode() ? SEPARATOR_ASCII : SEPARATOR_UNICODE;
}

/**
 * Get brand glyph (◆ or *)
 */
export function brandGlyph(): string {
	return isLowUnicode() ? BRAND_GLYPH_ASCII : BRAND_GLYPH_UNICODE;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Direct access (when you need both sets)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const glyphs = {
	unicode: {
		tools: TOOL_ICONS_UNICODE,
		status: STATUS_GLYPHS_UNICODE,
		git: GIT_GLYPHS_UNICODE,
		spinners: SPINNER_FRAMES_UNICODE,
		skeleton: SKELETON_FRAMES_UNICODE,
		progress: PROGRESS_UNICODE,
		separator: SEPARATOR_UNICODE,
		brand: BRAND_GLYPH_UNICODE,
	},
	ascii: {
		tools: TOOL_ICONS_ASCII,
		status: STATUS_GLYPHS_ASCII,
		git: GIT_GLYPHS_ASCII,
		spinners: SPINNER_FRAMES_ASCII,
		skeleton: SKELETON_FRAMES_ASCII,
		progress: PROGRESS_ASCII,
		separator: SEPARATOR_ASCII,
		brand: BRAND_GLYPH_ASCII,
	},
} as const;
