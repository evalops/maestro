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
		const layers = [" ", ".", ":", "-", "~", "*", "o", "O", "@"];

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
				const drift = Math.cos(angle * 2.2 - time * 0.7) * 0.04;
				const breathing = Math.sin(distance * 3 - time * 1.5) * 0.03;
				let intensity = 1 - (distance + swirl + pulse - ripple - drift);
				intensity += Math.exp(-distance * 2.5) * 0.35 + breathing;
				if (distance < 0.92) {
					const undertow = Math.sin(angle * 2 - time * 0.6 + distance * 4.5) * 0.05;
					const tide = Math.cos(distance * 3.2 - time * 1.1) * 0.03;
					intensity += undertow + tide;
				}
				intensity = Math.max(0, Math.min(1.2, intensity));

				const corePulse = 0.03 + (Math.sin(time * 1.4) + 1) * 0.02;
				const heartBeat = Math.sin(time * 4 + distance * 6) * 0.02;
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

				if (distance < 0.4 + corePulse) {
					const coreGlow = Math.max(0, Math.min(1, 0.65 + (0.4 + corePulse - distance) * 0.9 + heartBeat));
					if (distance < 0.2 + corePulse * 0.6) {
						char = distance % 0.05 > 0.025 ? "@" : "0";
						color = chalk.hex(WelcomeAnimation.interpolateGradient(Math.min(1, coreGlow + 0.2)));
					} else {
						char = distance % 0.08 > 0.04 ? "o" : "*";
						color = chalk.hex(WelcomeAnimation.interpolateGradient(coreGlow));
					}
				}

				if (distance < 0.92) {
					const ribbonPhase = Math.sin(angle * 3.1 - time * 1.3 + distance * 5.2);
					const ribbonMix = Math.max(0, Math.min(1, 0.45 + (0.92 - distance) * 0.45 + Math.sin(time * 0.7 + angle) * 0.15));
					if (Math.abs(ribbonPhase) < 0.08) {
						char = ribbonPhase > 0 ? "≈" : "~";
						color = chalk.hex(WelcomeAnimation.interpolateGradient(ribbonMix));
					} else {
						const gentleSheen = Math.sin(distance * 9 - time * 2.4 + angle * 2.2);
						if (gentleSheen > 0.8) {
							char = ".";
							color = chalk.hex(WelcomeAnimation.interpolateGradient(ribbonMix + 0.1));
						}
					}

					const eyeBandAngle = Math.sin(time * 0.6) * 0.5;
					const eyeRadius = 0.45 + Math.sin(time * 0.7) * 0.05;
					const eyeWidth = 0.1 + (Math.cos(time * 0.4) + 1) * 0.04;
					const angleDelta = Math.atan2(Math.sin(angle - eyeBandAngle), Math.cos(angle - eyeBandAngle));
					if (Math.abs(distance - eyeRadius) < 0.04 + corePulse * 0.8 && Math.abs(angleDelta) < eyeWidth) {
						char = angleDelta > 0 ? ">" : "<";
						const pupilGlow = Math.max(0, Math.min(1, 0.7 + Math.cos(time * 1.5 + angle * 3) * 0.2));
						color = chalk.hex(WelcomeAnimation.interpolateGradient(pupilGlow));
					}
				}

				const flowBands = [
					{
						radius: 0.32 + Math.sin(time * 1.4 + angle * 3.2) * 0.05,
						thickness: 0.016,
						chars: ["~", "-"],
						colorBias: 0.55,
					},
					{
						radius: 0.62 + Math.cos(time * 0.95 - angle * 2.8) * 0.08,
						thickness: 0.022,
						chars: ["\\", "/"],
						colorBias: 0.75,
					},
					{
						radius: 0.95 + Math.sin(time * 0.7 + angle * 1.6) * 0.06,
						thickness: 0.02,
						chars: ["=", "~"],
						colorBias: 0.35,
					},
				];

				for (const band of flowBands) {
					if (Math.abs(distance - band.radius) < band.thickness) {
						const gradientSeed = (Math.sin(angle * 2 + time * 1.5) + 1) / 2;
						const lerpValue = Math.max(0, Math.min(1, band.colorBias * 0.6 + gradientSeed * 0.4));
						char = distance < band.radius ? band.chars[0] : band.chars[1];
						color = chalk.hex(WelcomeAnimation.interpolateGradient(lerpValue));
						break;
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

				const finConfigs = [
					{ angle: Math.PI - 0.55, variance: 0.25, offset: 0.04, chars: [")", "="] },
					{ angle: -Math.PI + 0.55, variance: 0.25, offset: -0.04, chars: ["(", "="] },
				];
				for (const fin of finConfigs) {
					if (distance > 0.85 && distance < 1.2) {
						const delta = Math.atan2(Math.sin(angle - fin.angle), Math.cos(angle - fin.angle));
						if (Math.abs(delta) < fin.variance) {
							const finWave = Math.sin(time * 1.2 + distance * 6 + delta * 4);
							char = delta > fin.offset ? fin.chars[0] : fin.chars[1];
							const finGlow = Math.max(0, Math.min(1, 0.35 + (distance - 0.85) * 0.4 + finWave * 0.15));
							color = chalk.hex(WelcomeAnimation.interpolateGradient(finGlow));
							break;
						}
					}
				}

				const driftField = Math.sin((x * 0.35 + y * 0.45) * 0.7 - time * 1.1);
				if (driftField > 0.97 && char === " ") {
					char = ",";
					color = chalk.hex("#312e81");
				}

				const ribbonSpark = Math.sin(distance * 12 - time * 5 + angle * 6);
				if (ribbonSpark > 0.995) {
					char = ".";
					color = chalk.hex("#a5b4fc");
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
