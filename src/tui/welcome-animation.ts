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

		const noise = (x: number, y: number) =>
			Math.sin(x * 0.17 + y * 0.11 + time * 1.3) *
				Math.cos(x * 0.07 - y * 0.19 + time * 0.9);
		const starNoise = (x: number, y: number) =>
			Math.sin(x * 0.9 + y * 1.1 + time * 2.3) *
				Math.cos(x * 1.3 - y * 0.7 + time * 1.7);

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const skyGradient = 0.15 + (y / height) * 0.3;
				const twinkle = Math.pow(
					Math.max(0, starNoise(x, y) * 0.5 + Math.random() * 0.15),
					1.7,
				);
				const haze = noise(x * 0.4, y * 0.3) * 0.08;
				const base = clamp(skyGradient + haze + twinkle, 0, 1);
				chars[y][x] = twinkle > 0.35 ? "·" : " ";
				colors[y][x] = base;
			}
		}

		const rays = 6;
		for (let ray = 0; ray < rays; ray++) {
			const angle = (Math.PI * 2 * ray) / rays + time * 0.4;
			const flicker = Math.sin(time * 1.2 + ray) * 0.3 + 1.1;
			for (let d = 5; d < height * 0.7; d++) {
				const x = Math.floor(width / 2 + Math.cos(angle) * d * 0.8);
				const y = Math.floor(height / 2 + Math.sin(angle) * d * 0.4);
				if (x < 0 || y < 0 || x >= width || y >= height) continue;
				colors[y][x] = mix(colors[y][x], 0.6 + flicker * 0.2, 0.4);
				if (chars[y][x] === " ") {
					chars[y][x] = Math.random() > 0.7 ? "*" : "·";
				}
			}
		}

		const horizonY = height - 4;
		for (let x = 0; x < width; x++) {
			const wave =
				Math.sin(x * 0.2 + time * 0.8) * 0.3 +
				Math.sin(x * 0.05 + time * 0.3) * 0.2;
			const crest = Math.floor(horizonY + wave);
			if (crest >= 0 && crest < height) {
				chars[crest][x] = wave > 0 ? "≈" : "~";
				colors[crest][x] = mix(colors[crest][x], 0.4 + wave * 0.2, 0.5);
			}
			const shimmer = Math.sin(time * 2 + x * 0.3) * 0.2 + 0.3;
			if (crest + 1 < height) {
				chars[crest + 1][x] = "-";
				colors[crest + 1][x] = mix(
					colors[crest + 1][x],
					0.25 + shimmer,
					0.6,
				);
			}
		}

		const wingBeat = Math.sin(time * 3.4);
		const wingSpan = 18 + wingBeat * 5;
		const wingThickness = 5 - wingBeat * 1.2;
		const birdY = Math.floor(height / 2 + Math.sin(time * 0.9) * 2);
		const birdX = Math.floor(width / 2 + Math.sin(time * 0.4) * 10);
		const bodyRadius = 3.5;

		const wingProfile = (x: number) =>
			Math.exp(-Math.pow((x / wingSpan) * 2, 2)) * wingThickness;
		const insideWing = (x: number, y: number, flipped: 1 | -1) => {
			const localX = (x - birdX) * flipped;
			const localY = y - birdY - Math.sin(time * 4 + localX * 0.2);
			if (localX < 0 || localX > wingSpan) return false;
			return Math.abs(localY) < wingProfile(localX);
		};

		const insideBody = (x: number, y: number) => {
			const dx = (x - birdX) / bodyRadius;
			const dy = (y - birdY) / (bodyRadius * 0.8);
			return dx * dx + dy * dy < 1;
		};

		const plumeCurve = (tValue: number) =>
			(
				Math.sin(tValue * Math.PI * 2 + time * 1.5) * 3 +
				Math.cos(time * 0.8 + tValue * 3) * 2
			);
		for (let i = 0; i < 25; i++) {
			const tValue = (i + (Math.sin(time) + 1) * 0.5) / 25;
			const px = birdX - 2 - i * 0.9;
			const py = birdY + plumeCurve(tValue);
			const x = Math.floor(px + Math.random());
			const y = Math.floor(py + Math.random());
			if (x < 0 || y < 0 || x >= width || y >= height) continue;
			chars[y][x] = ",";
			colors[y][x] = mix(colors[y][x], 0.35 - tValue * 0.2, 0.7);
		}

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				let draw = false;
				if (insideBody(x, y)) {
					chars[y][x] = "@";
					colors[y][x] = mix(colors[y][x], 0.95, 0.8);
					this.trail.push({ x, y, life: 1 });
					draw = true;
				} else if (insideWing(x, y, 1) || insideWing(x, y, -1)) {
					const edge = Math.abs(y - birdY) / wingThickness;
					chars[y][x] = edge > 0.8 ? "/" : edge > 0.3 ? "= "[Math.random() > 0.5 ? 0 : 1] : "#";
					colors[y][x] = mix(colors[y][x], 0.8 - edge * 0.3, 0.9);
					draw = true;
				}
				if (!draw && Math.random() < 0.002) {
					this.trail.push({ x, y, life: 0.6 });
				}
			}
		}

		this.trail = this.trail
			.map((particle) => ({ ...particle, life: particle.life - 0.03 }))
			.filter((particle) => particle.life > 0);
		for (const particle of this.trail) {
			const { x, y, life } = particle;
			if (x < 0 || y < 0 || x >= width || y >= height) continue;
			const char = life > 0.4 ? "*" : life > 0.2 ? "." : "'";
			chars[y][x] = char;
			colors[y][x] = mix(colors[y][x], 0.4 + life * 0.4, 0.6);
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
