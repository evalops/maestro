import chalk from "chalk";

export const themePalette = {
	text: "#e2e8f0",
	muted: "#94a3b8",
	separator: "#4b5563",
	metric: "#f8fafc",
	brandGlyph: "#dcdafa",
	brand: "#cfd2f7",
	model: "#aab2c8",
	accentCool: "#a6d8ff",
	accentWarm: "#f5b17a",
	cacheRead: "#c6f7d6",
	cacheWrite: "#f5bfd2",
	cost: "#ffd6a5",
	success: "#9ae6b4",
	warning: "#ffb347",
	danger: "#ff8c69",
	info: "#c3b8ff",
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
	return chalk.hex(themePalette.text).bold(`\n${prefix}${label}\n`);
}

export function badge(
	label: string,
	value?: string,
	variant: BadgeVariant = "info",
): string {
	const color = badgeColors[variant];
	const content = value ? `${label}: ${value}` : label;
	return chalk.hex(color).bold(content);
}

export function separator(spacing = "  ·  "): string {
	return chalk.hex(themePalette.separator)(spacing);
}

export function muted(text: string): string {
	return chalk.hex(themePalette.muted)(text);
}

export function heading(label: string): string {
	return chalk.hex(themePalette.text).bold(label);
}

export function labeledValue(label: string, value: string): string {
	return `${chalk.hex(themePalette.muted)(`${label}:`)} ${value}`;
}

export function metricStat(
	glyph: string,
	color: string,
	value: string,
): string {
	return `${chalk.hex(color)(glyph)} ${chalk
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
	glyph: (): string => chalk.hex(themePalette.brandGlyph)("𝅘𝅥𝅮"),
	text: (): string => chalk.hex(themePalette.brand).bold("composer"),
	signature(modelName?: string, compact = false): string {
		const tone = modelName
			? `${chalk.hex(themePalette.model)(modelName)} `
			: "";
		const glyph = this.glyph();
		const name = compact ? "" : ` ${this.text()}`;
		return `${tone}${glyph}${name}`.trim();
	},
};

export const infoGlyph = {
	success: () => chalk.hex(themePalette.success)("[OK]"),
	warn: () => chalk.hex(themePalette.warning)("[WARN]"),
	danger: () => chalk.hex(themePalette.danger)("[ERROR]"),
};

export function highlightValue(value: string): string {
	return chalk.hex(themePalette.text).bold(value);
}

export function toneColor(variant: BadgeVariant = "info"): string {
	return badgeColors[variant];
}
