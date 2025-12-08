import chalk from "chalk";

/**
 * Terminal capabilities snapshot.
 */
export interface TerminalCapabilities {
	isTTY: boolean;
	columns: number;
	rows: number;
	colorLevel: number;
}

/**
 * Low-bandwidth configuration for remote connections.
 */
export interface LowBandwidthConfig {
	enabled: boolean;
	batchIntervalMs: number;
	scrollbackLimit: number;
}

/**
 * Render throttle interval for SSH connections.
 */
export const SSH_RENDER_INTERVAL_MS = 50;

/**
 * Get current terminal capabilities.
 */
export function getTerminalCapabilities(): TerminalCapabilities {
	return {
		isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
		columns: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
		colorLevel: chalk.level || 0,
	};
}

/**
 * Get low-bandwidth configuration based on environment.
 */
export function getLowBandwidthConfig(): LowBandwidthConfig {
	return {
		enabled:
			process.env.COMPOSER_TUI_LOW_BW === "1" ||
			process.env.COMPOSER_TUI_LOW_BW?.toLowerCase() === "true" ||
			Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
		batchIntervalMs:
			Number.parseInt(process.env.COMPOSER_TUI_LOW_BW_BATCH_MS ?? "", 10) ||
			120,
		scrollbackLimit:
			Number.parseInt(process.env.COMPOSER_TUI_SCROLLBACK ?? "", 10) || 600,
	};
}

/**
 * Check if running in minimal mode (SSH, restricted terminal, etc.).
 */
export function isMinimalMode(): boolean {
	return (
		process.env.COMPOSER_TUI_MINIMAL === "1" ||
		process.env.COMPOSER_TUI_MINIMAL?.toLowerCase() === "true" ||
		typeof process.env.SSH_TTY === "string" ||
		typeof process.env.SSH_CONNECTION === "string"
	);
}

/**
 * Get the render interval for the TUI.
 * Uses SSH interval for remote connections.
 */
export function getRenderInterval(): number {
	const envValue = process.env.COMPOSER_TUI_RENDER_INTERVAL_MS;
	let interval = Number.parseInt(envValue ?? "", 10);
	if (!Number.isFinite(interval)) {
		if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
			interval = SSH_RENDER_INTERVAL_MS;
		} else {
			interval = 0;
		}
	}
	return Math.max(0, interval);
}

/**
 * Probe the terminal background color.
 * Returns "dark" or "light" based on luminance, or null if detection fails.
 */
export async function probeTerminalBackground(): Promise<
	"dark" | "light" | null
> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) return null;

	const prevRaw = process.stdin.isRaw;
	return await new Promise((resolve) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			try {
				if (process.stdin.setRawMode && prevRaw === false) {
					process.stdin.setRawMode(false);
				}
			} catch {
				// ignore
			}
			process.stdin.off("data", handler);
		};

		const timeout = setTimeout(() => {
			cleanup();
			resolve(null);
		}, 300);

		const handler = (data: Buffer) => {
			const escIndex = data.indexOf(0x1b);
			if (escIndex === -1) return;
			const slice = data.slice(escIndex);
			const text = slice.toString();
			const start = text.indexOf("]11;");
			if (start === -1) return;
			const payloadStart = start + 4;
			const end = text.indexOf("\u0007", payloadStart);
			if (end === -1) return;
			const color = text.slice(payloadStart, end);
			const luminance = parseLuminance(color);
			cleanup();
			resolve(luminance);
		};

		try {
			if (process.stdin.setRawMode && prevRaw === false) {
				process.stdin.setRawMode(true);
			}
		} catch {
			resolve(null);
			return;
		}

		process.stdin.on("data", handler);
		process.stdout.write("\u001b]11;?\u0007");
	});
}

/**
 * Parse RGB luminance from various color formats.
 */
function parseLuminance(color: string): "dark" | "light" | null {
	let r = 0;
	let g = 0;
	let b = 0;
	if (color.startsWith("rgb:")) {
		const parts = color.substring(4).split("/");
		r = Number.parseInt(parts[0] ?? "0", 16) >> 8;
		g = Number.parseInt(parts[1] ?? "0", 16) >> 8;
		b = Number.parseInt(parts[2] ?? "0", 16) >> 8;
	} else if (color.startsWith("#")) {
		r = Number.parseInt(color.substring(1, 3) || "0", 16);
		g = Number.parseInt(color.substring(3, 5) || "0", 16);
		b = Number.parseInt(color.substring(5, 7) || "0", 16);
	} else if (color.startsWith("rgb(")) {
		const parts = color.substring(4, color.length - 1).split(",");
		r = Number.parseInt(parts[0] ?? "0", 10);
		g = Number.parseInt(parts[1] ?? "0", 10);
		b = Number.parseInt(parts[2] ?? "0", 10);
	} else {
		return null;
	}

	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? "light" : "dark";
}
