import chalk from "chalk";

const ORB_PALETTE: { stop: number; color: [number, number, number] }[] = [
	{ stop: 0, color: [14, 165, 233] },
	{ stop: 0.3, color: [56, 189, 248] },
	{ stop: 0.55, color: [139, 92, 246] },
	{ stop: 0.75, color: [236, 72, 153] },
	{ stop: 1, color: [249, 115, 22] },
];

export function gradientColor(intensity: number): (input: string) => string {
	const hex = interpolateGradient(intensity);
	return chalk.hex(hex);
}

export function interpolateGradient(value: number): string {
	const clamped = Math.max(0, Math.min(1, value));
	for (let i = 0; i < ORB_PALETTE.length - 1; i++) {
		const current = ORB_PALETTE[i]!;
		const next = ORB_PALETTE[i + 1]!;
		if (clamped <= next.stop) {
			const range = next.stop - current.stop || 1;
			const ratio = (clamped - current.stop) / range;
			const r = lerp(current.color[0]!, next.color[0]!, ratio);
			const g = lerp(current.color[1]!, next.color[1]!, ratio);
			const b = lerp(current.color[2]!, next.color[2]!, ratio);
			return rgbToHex(r, g, b);
		}
	}
	const last = ORB_PALETTE[ORB_PALETTE.length - 1]!;
	return rgbToHex(last.color[0]!, last.color[1]!, last.color[2]!);
}

function lerp(start: number, end: number, ratio: number): number {
	return start + (end - start) * ratio;
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
