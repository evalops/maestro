/** Color palette and formatting helpers for dashboard charts. */

export const COLORS = [
	"#2dd4bf",
	"#60a5fa",
	"#34d399",
	"#fbbf24",
	"#f87171",
	"#a78bfa",
	"#f472b6",
	"#38bdf8",
];

export function getColor(index: number): string {
	return COLORS[index % COLORS.length]!;
}

export function formatNumber(value: number): string {
	if (Math.abs(value) >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (Math.abs(value) >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
}
