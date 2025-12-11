import { visibleWidth } from "@evalops/tui";
import { theme } from "../../theme/theme.js";
import {
	statusGlyph as rawStatusGlyph,
	separatorChars,
} from "../utils/glyphs.js";

type Status = "success" | "error" | "pending" | "info";

/** Map render-style status names to glyph status names */
const STATUS_MAP: Record<
	Status,
	{
		glyphKey: "success" | "error" | "running" | "info";
		color: Parameters<typeof theme.fg>[0];
	}
> = {
	success: { glyphKey: "success", color: "success" },
	error: { glyphKey: "error", color: "error" },
	pending: { glyphKey: "running", color: "warning" }, // "pending" here means "in progress"
	info: { glyphKey: "info", color: "muted" },
};

function padToWidth(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current >= width) return text;
	return text + " ".repeat(width - current);
}

/**
 * Render a small ANSI "card": adds left padding and a muted gutter so tool
 * outputs share a consistent visual rhythm without heavy box-drawing.
 */
export function renderCard(
	lines: string[],
	options: {
		padding?: number;
		gutterColor?: Parameters<typeof theme.fg>[0];
	} = {},
): string {
	if (!lines.length) return "";
	const padding = Math.max(0, options.padding ?? 1);
	const gutterColor = options.gutterColor ?? "borderMuted";
	const gutter = theme.fg(gutterColor, separatorChars().vertical);
	const indent = " ".repeat(padding);
	return lines
		.flatMap((line) => (line ? line.split(/\r?\n/) : [""]))
		.map((line) => `${gutter} ${indent}${line}`)
		.join("\n");
}

/**
 * Consistent status glyphs (fixed column width) so lists don't jitter while
 * streaming updates.
 */
export function statusGlyph(status: Status): string {
	const { glyphKey, color } = STATUS_MAP[status];
	const icon = rawStatusGlyph(glyphKey);
	return theme.fg(color, padToWidth(icon, 2));
}

/**
 * Shared headline builder for tool renderers: colored label plus muted meta.
 */
export function formatHeadline(label: string, meta?: string): string {
	const base = theme.bold(theme.fg("accent", label));
	if (!meta) return base;
	return `${base} ${theme.fg("muted", meta)}`;
}
