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

		// Create a pulsing gradient circle effect using ASCII
		const width = 40;
		const height = 15;
		const centerX = width / 2;
		const centerY = height / 2;

		// Pulsing radius
		const baseRadius = 8;
		const pulse = Math.sin(time) * 2;
		const radius = baseRadius + pulse;

		for (let y = 0; y < height; y++) {
			let line = "";
			for (let x = 0; x < width; x++) {
				const dx = x - centerX;
				const dy = (y - centerY) * 2; // Compensate for character aspect ratio
				const distance = Math.sqrt(dx * dx + dy * dy);

				// Create layered effect
				const wave = Math.sin(distance * 0.5 - time * 2) * 0.5 + 0.5;
				const brightness = Math.max(0, 1 - Math.abs(distance - radius) / 4) * wave;

				// Choose character based on brightness
				let char = " ";
				let color = chalk.gray;
				if (brightness > 0.8) {
					char = "█";
					color = chalk.hex("#ffd6a5");
				} else if (brightness > 0.6) {
					char = "▓";
					color = chalk.hex("#ffb87a");
				} else if (brightness > 0.4) {
					char = "▒";
					color = chalk.hex("#ff9a50");
				} else if (brightness > 0.2) {
					char = "░";
					color = chalk.hex("#cc7a40");
				}

				line += color(char);
			}
			lines.push(line);
		}

		// Add centered text below
		lines.push("");
		const title = chalk.hex("#a5b4fc").bold("composer");
		const subtitle = chalk.dim("ready to code");
		lines.push(this.centerText(title, width));
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
}
