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
	private trail: Array<{ x: number; y: number; life: number }> = [];

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
		const time = this.frame * 0.08;
		const width = 64;
		const height = 22;
		const chars = Array.from({ length: height }, () =>
			Array.from({ length: width }, () => " "),
		);
		const colors = Array.from({ length: height }, () =>
			Array.from({ length: width }, () => 0),
		);
		const clamp = (value: number, min: number, max: number) =>
			Math.max(min, Math.min(max, value));
		const mix = (prev: number, next: number, alpha: number) =>
			prev * (1 - alpha) + next * alpha;
		const crescendo = 0.55 + 0.45 * ((Math.sin(time * 0.4) + 1) / 2);
		const staffPalette = [0.2, 0.32, 0.44, 0.56];

		const staffSpacing = 3;
		const staffCount = 4;
		const staffStartY = 5;
		for (let i = 0; i < staffCount; i++) {
			const baseY = staffStartY + i * staffSpacing;
			const staffHue = staffPalette[i % staffPalette.length] * crescendo;
			for (let line = 0; line < 5; line++) {
				const y = clamp(baseY + line, 0, height - 1);
				for (let x = 0; x < width; x++) {
					const waviness = Math.sin((x + time * 20 + i * 10) * 0.05) * 0.3;
					const offsetY = clamp(y + Math.round(waviness), 0, height - 1);
					chars[offsetY][x] =
						chars[offsetY][x] === " " ? "─" : chars[offsetY][x];
					colors[offsetY][x] = mix(colors[offsetY][x], staffHue, 0.7);
				}
			}
		}

		const divisionHeight = 15;
		const measureSpacing = 8;
		const sweep = (time * 2) % measureSpacing;
		for (
			let x = -measureSpacing;
			x < width + measureSpacing;
			x += measureSpacing
		) {
			const position = Math.floor(x + sweep);
			const fade = clamp(
				1 - Math.abs((position - width / 2) / (width / 2)),
				0.2,
				1,
			);
			for (let y = staffStartY - 1; y < staffStartY + divisionHeight; y++) {
				if (position < 0 || y < 0 || position >= width || y >= height) continue;
				chars[y][position] = "│";
				colors[y][position] = mix(
					colors[y][position],
					0.2 * crescendo * fade,
					0.6,
				);
			}
		}

		const noteCount = 18;
		for (let i = 0; i < noteCount; i++) {
			const lane = i % staffCount;
			const laneY = staffStartY + lane * staffSpacing + 2;
			const x = clamp(
				Math.floor(
					(i / noteCount) * width * 1.1 + Math.sin(time * 0.6 + i) * 4,
				),
				0,
				width - 1,
			);
			const yOffset =
				Math.sin(time * 1.3 + i * 0.9) * 1.5 +
				Math.cos(x * 0.05 + time * 0.4) * 0.6;
			const y = clamp(Math.floor(laneY + yOffset), 0, height - 1);
			const glyph = Math.random() > 0.7 ? "♩" : "●";
			chars[y][x] = glyph;
			colors[y][x] = mix(colors[y][x], 0.55 + 0.35 * crescendo, 0.8);
			const stemLength = 3 + (i % 2);
			for (let stem = 1; stem <= stemLength; stem++) {
				const stemY = clamp(y - stem, 0, height - 1);
				if (x + 1 < width) {
					chars[stemY][x + 1] = "│";
					colors[stemY][x + 1] = mix(
						colors[stemY][x + 1],
						0.4 + 0.25 * crescendo,
						0.7,
					);
				}
			}
		}

		const batonLength = 14;
		const batonCenterX = width - 12;
		const batonCenterY = Math.floor(height / 2 + Math.sin(time * 0.8) * 3);
		const batonAngle = Math.sin(time * 0.9) * 0.4 - 0.8;
		for (let i = -batonLength; i <= batonLength; i++) {
			const radius = i / batonLength;
			const x = Math.floor(batonCenterX + Math.cos(batonAngle) * i);
			const y = Math.floor(batonCenterY + Math.sin(batonAngle) * i);
			if (x < 0 || y < 0 || x >= width || y >= height) continue;
			const char = i === batonLength ? "✧" : "╲╱"[Number(radius > 0)];
			chars[y][x] = char;
			colors[y][x] = mix(
				colors[y][x],
				(0.75 - Math.abs(radius) * 0.3) * crescendo,
				0.6,
			);
		}

		const floatingSymbols = 8;
		for (let i = 0; i < floatingSymbols; i++) {
			const x = Math.floor((i / floatingSymbols) * width);
			const y = clamp(
				Math.floor(
					staffStartY -
						2 +
						Math.sin(time * 0.5 + i) * 6 +
						Math.cos(x * 0.1) * 1.5,
				),
				0,
				height - 1,
			);
			chars[y][x] = "♪";
			colors[y][x] = mix(colors[y][x], 0.45 + 0.4 * crescendo, 0.7);
		}

		const orchestraBaseY = height - 3;
		for (let x = 0; x < width; x++) {
			const envelope = (Math.sin(time * 0.3 + x * 0.04) + 1) / 2;
			const heightOffset = Math.floor(envelope * 3 + Math.sin(time + x * 0.2));
			for (let h = 0; h < heightOffset; h++) {
				const y = clamp(orchestraBaseY - h, 0, height - 1);
				const barChar = "▁▂▃▄▅"[Math.min(h, 4)];
				chars[y][x] = chars[y][x] === " " && barChar ? barChar : chars[y][x];
				colors[y][x] = mix(colors[y][x], 0.25 + 0.2 * crescendo, 0.5);
			}
		}

		this.trail = this.trail
			.map((particle) => ({ ...particle, life: particle.life - 0.03 }))
			.filter((particle) => particle.life > 0);
		for (const particle of this.trail) {
			const { x, y, life } = particle;
			if (x < 0 || y < 0 || x >= width || y >= height) continue;
			const char = life > 0.5 ? "*" : life > 0.25 ? "." : "'";
			chars[y][x] = char;
			colors[y][x] = mix(colors[y][x], 0.35 + life * 0.4, 0.6);
		}

		const lines = chars.map((row, y) =>
			row
				.map((char, x) => {
					if (char === " ") {
						return " ";
					}
					const colorValue = clamp(colors[y][x], 0, 1);
					const painter = gradientColor(colorValue);
					return painter(char);
				})
				.join(""),
		);
		this.textComponent.setText(lines.join("\n"));
	}
}
