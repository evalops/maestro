import chalk from "chalk";
import { Container, Text } from "../tui-lib/index.js";
import { gradientColor } from "./welcome-colors.js";

/**
 * Beautiful animated welcome screen shown before user enters text
 */
export class WelcomeAnimation extends Container {
	private frame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private textComponent: Text;
	private onRenderRequest?: () => void;

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

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
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
		const waveAngle = Math.sin(time * 0.42) * Math.PI;
		const waveFrequency = 2.8 + Math.sin(time * 0.2) * 1.7;
		const ringDensity = 13 + Math.sin(time * 0.18) * 2.5;
		const orbiters = 5;
		const orbitPositions = Array.from({ length: orbiters }).map((_, index) => {
			const offset = (index / orbiters) * Math.PI * 2 + time * 0.8;
			const radius = 0.18 + Math.sin(time * 0.3 + index) * 0.03;
			return { angle: offset, radius };
		});

		for (let y = 0; y < height; y++) {
			let line = "";
			for (let x = 0; x < width; x++) {
				let char = " ";
				let color: (input: string) => string = (input) => input;

				const dx = (x - centerX) / baseRadius;
				const dy = (y - centerY) / baseRadius;
				const distance = Math.sqrt(dx * dx + dy * dy);
				const angle = Math.atan2(dy, dx);

				const swirl = Math.sin(angle * 3.8 + time * 1.6) * 0.08;
				const pulse = Math.sin(time * 1.3 + distance * 2.2) * 0.05;
				const ripple = Math.sin(distance * 9 - time * 3.3 + angle * 2.4) * 0.05;
				const drift = Math.cos(angle * 2.3 - time * 0.8) * 0.04;
				const breathing = Math.sin(distance * 3.2 - time * 1.4) * 0.03;
				let intensity = 1 - (distance + swirl + pulse - ripple - drift);
				intensity += Math.exp(-distance * 2.4) * 0.4 + breathing;
				if (distance < 0.92) {
					const undertow =
						Math.sin(angle * 2 - time * 0.6 + distance * 4.5) * 0.05;
					const tide = Math.cos(distance * 3.4 - time * 1.1) * 0.03;
					intensity += undertow + tide;
				}
				intensity = Math.max(0, Math.min(1.2, intensity));

				if (intensity > 0.04) {
					const idx = Math.min(
						layers.length - 1,
						Math.floor(intensity * (layers.length - 1)),
					);
					char = layers[idx];
					color = gradientColor(Math.min(1, intensity + 0.2));
				} else {
					const twinkle = Math.sin((x + y) * 0.3 + time * 3.1);
					if (twinkle > 0.985) {
						char = "·";
						color = gradientColor(0.25);
					}
				}

				if (distance < 0.4) {
					const corePulse = 0.035 + (Math.sin(time * 1.5) + 1) * 0.025;
					const heartBeat = Math.sin(time * 3.6 + distance * 7) * 0.025;
					const coreGlow = Math.max(
						0,
						Math.min(1, 0.65 + (0.4 + corePulse - distance) * 0.95 + heartBeat),
					);
					if (distance < 0.18 + corePulse * 0.65) {
						char = distance % 0.05 > 0.025 ? "@" : "0";
						color = gradientColor(Math.min(1, coreGlow + 0.2));
					} else {
						char = distance % 0.08 > 0.04 ? "o" : "*";
						color = gradientColor(coreGlow);
					}
				}

				const ribbonPhase = Math.sin(angle * 3.1 - time * 1.3 + distance * 5.2);
				const ribbonMix = Math.max(
					0,
					Math.min(
						1,
						0.45 +
							(0.92 - distance) * 0.45 +
							Math.sin(time * 0.7 + angle) * 0.15,
					),
				);
				if (Math.abs(ribbonPhase) < 0.08) {
					char = ribbonPhase > 0 ? "≈" : "~";
					color = gradientColor(ribbonMix);
				}

				for (const orb of orbitPositions) {
					const ox = Math.cos(orb.angle) * orb.radius;
					const oy = Math.sin(orb.angle) * orb.radius;
					const d = Math.sqrt((dx - ox) ** 2 + (dy - oy) ** 2);
					if (d < 0.03 + Math.sin(time * 0.9 + orb.angle) * 0.01) {
						char = orb.angle % Math.PI > 0.5 ? "●" : "○";
						color = gradientColor(0.7);
					}
				}

				const ray = Math.sin(angle * 3 - time * 2 + distance * 7);
				const rayIntensity = Math.max(0, 0.25 - Math.abs(ray) * 0.18);
				if (rayIntensity > 0.02 && distance > 0.35) {
					char = ray > 0 ? "\\" : "/";
					color = gradientColor(0.3 + rayIntensity);
				}

				line += color(char);
			}
			lines.push(line);
		}

		const crest = Math.sin(time * 0.6) * 0.5;
		const crestLine = Array.from({ length: width }).map((_, index) => {
			const wave = Math.sin(index * 0.15 + crest) * 0.35;
			return gradientColor(0.3 + wave * 0.2)("~");
		});
		lines.unshift(crestLine.join(""));
		lines.push(crestLine.join(""));
		this.textComponent.setText(lines.join("\n"));
	}
}
