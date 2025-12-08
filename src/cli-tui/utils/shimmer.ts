import chalk, { type ChalkInstance } from "chalk";
import { interpolateGradient } from "../welcome-colors.js";

const shimmerEpoch = Date.now();
// Force colors for shimmer output regardless of NO_COLOR leakage in tests/env.
const colorChalk: ChalkInstance =
	// Chalk v5 exposes ChalkInstance directly; no public constructor is exported in some builds.
	// Fall back to the default singleton when custom instances aren't supported.
	(
		chalk as unknown as {
			Instance?: new (opts: { level: number }) => ChalkInstance;
		}
	).Instance
		? new (
				chalk as unknown as {
					Instance: new (opts: { level: number }) => ChalkInstance;
				}
			).Instance({ level: 3 })
		: chalk;

export interface ShimmerOptions {
	padding?: number;
	bandWidth?: number;
	sweepSeconds?: number;
	intensityScale?: number;
	baseColor?: string;
	highlightColor?: string;
	time?: number; // seconds
	bold?: boolean;
}

const DEFAULT_BASE = "#94a3b8"; // slate-400

export function shimmerText(
	text: string,
	options: ShimmerOptions = {},
): string {
	if (!text) return "";
	const chars = [...text];
	const padding = options.padding ?? 6;
	const bandWidth = Math.max(1, options.bandWidth ?? 4);
	const sweepSeconds = Math.max(0.1, options.sweepSeconds ?? 2.2);
	const intensityScale = options.intensityScale ?? 1;
	const baseColor = options.baseColor ?? DEFAULT_BASE;
	const highlightColor = options.highlightColor ?? interpolateGradient(0.85);
	const elapsedSeconds = options.time ?? (Date.now() - shimmerEpoch) / 1000;
	const period = chars.length + padding * 2;
	const sweepPos = ((elapsedSeconds % sweepSeconds) / sweepSeconds) * period;
	return chars
		.map((ch, index) => {
			const cursor = index + padding;
			const dist = Math.abs(cursor - sweepPos);
			const withinBand = dist <= bandWidth;
			const t = withinBand
				? 0.5 * (1 + Math.cos((Math.PI * dist) / bandWidth))
				: 0;
			const mixValue = Math.min(1, Math.max(0, t * intensityScale));
			const blended = mixHex(baseColor, highlightColor, mixValue);
			const painter = colorChalk.hex(blended);
			return (options.bold ?? true) ? painter.bold(ch) : painter(ch);
		})
		.join("");
}

function mixHex(base: string, target: string, value: number): string {
	const [br, bg, bb] = hexToRgb(base);
	const [tr, tg, tb] = hexToRgb(target);
	const r = Math.round(br + (tr - br) * value);
	const g = Math.round(bg + (tg - bg) * value);
	const b = Math.round(bb + (tb - bb) * value);
	return rgbToHex(r, g, b);
}

function hexToRgb(hex: string): [number, number, number] {
	const normalized = hex.replace(/^#/, "");
	const bigint = Number.parseInt(normalized, 16);
	if (Number.isNaN(bigint)) {
		return [148, 163, 184];
	}
	return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (value: number) =>
		Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
