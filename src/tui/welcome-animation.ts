import { Container, Text } from "../tui-lib/index.js";
import chalk from "chalk";

/**
 * Beautiful animated welcome screen shown before user enters text
 */
export class WelcomeAnimation extends Container {
	private frame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private textComponent: Text;
	private onRenderRequest?: () => void;
	private static readonly orbPalette: { stop: number; color: [number, number, number] }[] = [
		{ stop: 0, color: [14, 165, 233] }, // cyan
		{ stop: 0.3, color: [56, 189, 248] }, // sky blue
		{ stop: 0.55, color: [139, 92, 246] }, // violet
		{ stop: 0.75, color: [236, 72, 153] }, // pink
		{ stop: 1, color: [249, 115, 22] }, // amber highlight
	];

	constructor(onRenderRequest?: () => void) {
		super();
		this.onRenderRequest = onRenderRequest;
		this.textComponent = new Text("", 0, 0);
		this.addChild(this.textComponent);
		this.startAnimation();
	}

	private startAnimation(): void {
		this.intervalId = setInterval(() => {
			this.frame++;
			this.updateFrame();
			// Request UI re-render
			if (this.onRenderRequest) {
				this.onRenderRequest();
			}
		}, 100); // Update every 100ms
	}

	private updateFrame(): void {
		const time = this.frame * 0.1;
		const lines: string[] = [];

		const width = 64;
		const height = 22;
		const centerX = width / 2;
		const centerY = height / 2 - 1;
		const baseRadius = Math.min(width, height) * 0.4;
		const layers = [" ", ".", "·", "°", "o", "O", "@"];

		for (let y = 0; y < height; y++) {
			let line = "";

			for (let x = 0; x < width; x++) {
				let char = " ";
				let color: (input: string) => string = (input) => input;

				const dx = (x - centerX) / baseRadius;
				const dy = (y - centerY) / baseRadius;
				const distance = Math.sqrt(dx * dx + dy * dy);
				const angle = Math.atan2(dy, dx);

				const swirl = Math.sin(angle * 3.5 + time * 1.5) * 0.08;
				const pulse = Math.sin(time * 1.2) * 0.05;
				const ripple = Math.sin(distance * 8 - time * 3 + angle * 2) * 0.04;
				let intensity = 1 - (distance + swirl + pulse - ripple);
				intensity += Math.exp(-distance * 2.5) * 0.3;
				intensity = Math.max(0, Math.min(1.15, intensity));

				if (intensity > 0.04) {
					const idx = Math.min(layers.length - 1, Math.floor(intensity * (layers.length - 1)));
					char = layers[idx];
					color = chalk.hex(WelcomeAnimation.interpolateGradient(Math.min(1, intensity + 0.2)));
				} else {
					const twinkle = Math.sin((x + y) * 0.3 + time * 3);
					if (twinkle > 0.98) {
						char = "·";
						color = chalk.hex("#312e81");
					}
				}

				const orbitRadius = 1.05;
				const orbitWave = Math.sin(time + angle * 2) * 0.03;
				if (Math.abs(distance - orbitRadius + orbitWave) < 0.02) {
					char = distance > 1 ? "~" : "≈";
					color = chalk.hex("#c4b5fd");
				}

				const highlightBand = Math.abs(distance - 0.35 - Math.sin(time * 2 + angle * 5) * 0.03);
				if (highlightBand < 0.02) {
					char = "*";
					color = chalk.hex("#f472b6");
				}

				line += color(char);
			}
			lines.push(line);
		}

		// Add centered text below
		lines.push("");
		const orb = chalk.hex("#f472b6")("◯");
		const title = chalk.hex("#c4b5fd").bold("composer");
		const titleWithOrb = `${orb} ${title}`;
		const subtitle = chalk.hex("#a78bfa")("orchestrating your code");
		lines.push(this.centerText(titleWithOrb, width));
		lines.push(this.centerText(subtitle, width));

		this.textComponent.setText(lines.join("\n"));
	}

	private centerText(text: string, width: number): string {
		// Strip ANSI codes to get actual length
		const plainText = text.replace(/\u001b\[[0-9;]*m/g, "");
		const padding = Math.max(0, Math.floor((width - plainText.length) / 2));
		return " ".repeat(padding) + text;
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private static interpolateGradient(value: number): string {
		const palette = WelcomeAnimation.orbPalette;
		const clamped = Math.max(0, Math.min(1, value));

		for (let i = 0; i < palette.length - 1; i++) {
			const current = palette[i];
			const next = palette[i + 1];

			if (clamped <= next.stop) {
				const range = next.stop - current.stop || 1;
				const ratio = (clamped - current.stop) / range;
				const r = WelcomeAnimation.lerp(current.color[0], next.color[0], ratio);
				const g = WelcomeAnimation.lerp(current.color[1], next.color[1], ratio);
				const b = WelcomeAnimation.lerp(current.color[2], next.color[2], ratio);
				return WelcomeAnimation.rgbToHex(r, g, b);
			}
		}

		const last = palette[palette.length - 1];
		return WelcomeAnimation.rgbToHex(last.color[0], last.color[1], last.color[2]);
	}

	private static lerp(start: number, end: number, ratio: number): number {
		return start + (end - start) * ratio;
	}

	private static rgbToHex(r: number, g: number, b: number): string {
		const toHex = (value: number) =>
			Math.max(0, Math.min(255, Math.round(value)))
				.toString(16)
				.padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}
}
