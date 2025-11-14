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

		// Musical staff with flowing notes
		const width = 60;
		const height = 17;
		
		// Staff lines positions (5 lines like real musical staff)
		const staffLines = [5, 7, 9, 11, 13];
		const staffColor = chalk.hex("#8b8b8b");
		
		// Musical note characters
		const notes = ["♪", "♫", "♩", "♬"];
		
		// Create multiple flowing notes at different positions/speeds
		const notePositions = [
			{ speed: 0.8, offset: 0, verticalWave: 1.2, noteIndex: 0 },
			{ speed: 1.2, offset: 15, verticalWave: 0.8, noteIndex: 1 },
			{ speed: 0.6, offset: 30, verticalWave: 1.5, noteIndex: 2 },
			{ speed: 1.0, offset: 45, verticalWave: 1.0, noteIndex: 3 },
			{ speed: 0.9, offset: 8, verticalWave: 0.9, noteIndex: 1 },
		];

		// Build the frame
		for (let y = 0; y < height; y++) {
			let line = "";
			
			for (let x = 0; x < width; x++) {
				let char = " ";
				let color = chalk.gray;
				
				// Draw staff lines
				if (staffLines.includes(y)) {
					char = "─";
					color = staffColor;
				}
				
				// Draw flowing notes
				for (const notePos of notePositions) {
					// Calculate note position with wrapping
					const noteX = ((time * notePos.speed * 5 + notePos.offset) % (width + 10)) - 5;
					
					// Vertical oscillation
					const verticalOffset = Math.sin(time * notePos.verticalWave + notePos.offset) * 2;
					const noteY = 9 + verticalOffset; // Center around middle staff line
					
					// Check if note should be drawn at this position
					if (Math.abs(x - noteX) < 1 && Math.abs(y - noteY) < 0.5) {
						// Fade in/out based on position
						const fadeIn = Math.min(1, noteX / 5);
						const fadeOut = Math.min(1, (width - noteX) / 5);
						const alpha = Math.min(fadeIn, fadeOut);
						
						if (alpha > 0.3) {
							char = notes[notePos.noteIndex];
							// Color gradient based on position
							if (alpha > 0.8) {
								color = chalk.hex("#ffd6a5");
							} else if (alpha > 0.6) {
								color = chalk.hex("#ffb87a");
							} else if (alpha > 0.4) {
								color = chalk.hex("#ff9a50");
							} else {
								color = chalk.hex("#cc7a40");
							}
						}
					}
				}
				
				line += color(char);
			}
			lines.push(line);
		}

		// Add centered text below
		lines.push("");
		const title = chalk.hex("#a5b4fc").bold("composer");
		const subtitle = chalk.dim("orchestrating your code");
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
