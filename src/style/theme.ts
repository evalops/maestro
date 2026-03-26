import chalk, { Chalk } from "chalk";

type OptionalBool = boolean | undefined;

function parseEnvFlag(value?: string | null): OptionalBool {
	if (value === undefined || value === null) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

const isStdoutTTY = Boolean(process.stdout?.isTTY);

const envForceColor = parseEnvFlag(process.env.MAESTRO_FORCE_COLOR);
const envNoColor = parseEnvFlag(process.env.MAESTRO_NO_COLOR);
const globalNoColor = process.env.NO_COLOR !== undefined ? true : undefined;
const globalForceColor = parseEnvFlag(process.env.FORCE_COLOR);
const resolvedNoColor = envNoColor ?? globalNoColor;

const resolvedForceColor = envForceColor ?? globalForceColor;

let shouldUseColor: boolean;
if (resolvedNoColor === true) {
	shouldUseColor = false;
} else if (resolvedForceColor === true) {
	shouldUseColor = true;
} else if (resolvedForceColor === false) {
	shouldUseColor = false;
} else {
	shouldUseColor = isStdoutTTY;
}

const chalkTheme = new Chalk({
	level: shouldUseColor ? chalk.level : 0,
});

export const themePalette = {
	// Text hierarchy
	text: "#f8fafc",
	muted: "#94a3b8",
	dim: "#64748b",
	// Structural
	separator: "#475569",
	border: "#334155",
	// Metrics
	metric: "#f8fafc",
	// Brand
	brandGlyph: "#c084fc",
	brand: "#c084fc",
	model: "#94a3b8",
	// Accents
	accentCool: "#7dd3fc",
	accentWarm: "#fbbf24",
	// Token stats
	cacheRead: "#86efac",
	cacheWrite: "#c4b5fd",
	cost: "#fbbf24",
	// Semantic
	success: "#86efac",
	warning: "#fde047",
	danger: "#fca5a5",
	info: "#93c5fd",
	// Ruby (for stages)
	rubyPrimary: "#c084fc",
	rubyHighlight: "#e879f9",
	// Italic styling
	italic: "#7dd3fc",
	italicBorder: "#0ea5e9",
} as const;

export type BadgeVariant = "info" | "success" | "warn" | "danger";

const badgeColors: Record<BadgeVariant, string> = {
	info: themePalette.info,
	success: themePalette.success,
	warn: themePalette.warning,
	danger: themePalette.danger,
};

export function sectionHeading(label: string, icon = ""): string {
	const prefix = icon ? `${icon} ` : "";
	return chalkTheme.hex(themePalette.text).bold(`\n${prefix}${label}\n`);
}

export function badge(
	label: string,
	value?: string,
	variant: BadgeVariant = "info",
): string {
	const color = badgeColors[variant];
	const content = value ? `${label}: ${value}` : label;
	return chalkTheme.hex(color).bold(content);
}

export function separator(spacing = "  ·  "): string {
	return chalkTheme.hex(themePalette.separator)(spacing);
}

export function muted(text: string): string {
	return chalkTheme.hex(themePalette.muted)(text);
}

export function heading(label: string): string {
	return chalkTheme.hex(themePalette.text).bold(label);
}

export function labeledValue(label: string, value: string): string {
	return `${chalkTheme.hex(themePalette.muted)(`${label}:`)} ${value}`;
}

export function metricStat(
	glyph: string,
	color: string,
	value: string,
): string {
	return `${chalkTheme.hex(color)(glyph)} ${chalkTheme
		.hex(themePalette.metric)
		.bold(value)}`;
}

export function contextualBadge(
	label: string,
	value: number,
	options?: { warn?: number; danger?: number; unit?: string },
): string {
	const warn = options?.warn ?? 80;
	const danger = options?.danger ?? 90;
	const unit = options?.unit ?? "%";
	let variant: BadgeVariant = "info";
	if (value >= danger) variant = "danger";
	else if (value >= warn) variant = "warn";
	return badge(`${label} ${value.toFixed(1)}${unit}`, undefined, variant);
}

export const brand = {
	glyph: (): string => chalkTheme.hex(themePalette.brandGlyph)("◆"),
	text: (): string => chalkTheme.hex(themePalette.brand).bold("composer"),
	signature(modelName?: string, compact = false): string {
		const tone = modelName
			? `${chalkTheme.hex(themePalette.model)(modelName)} `
			: "";
		const glyph = this.glyph();
		const name = compact ? "" : ` ${this.text()}`;
		return `${tone}${glyph}${name}`.trim();
	},
};

export const infoGlyph = {
	success: () => chalkTheme.hex(themePalette.success)("[OK]"),
	warn: () => chalkTheme.hex(themePalette.warning)("[WARN]"),
	danger: () => chalkTheme.hex(themePalette.danger)("[ERROR]"),
};

export function highlightValue(value: string): string {
	return chalkTheme.hex(themePalette.text).bold(value);
}

export function toneColor(variant: BadgeVariant = "info"): string {
	return badgeColors[variant];
}

/**
 * Apply italic styling with the theme's italic color.
 * Use for thinking blocks, quoted content, and emphasis.
 */
export function italic(text: string): string {
	return chalkTheme.hex(themePalette.italic).italic(text);
}

/**
 * Apply italic styling with a custom color.
 * Use sparingly - prefer the themed italic() function.
 */
export function italicWithColor(text: string, color: string): string {
	return chalkTheme.hex(color).italic(text);
}
