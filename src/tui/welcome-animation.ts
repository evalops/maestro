import { Container, Text, visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import { PANEL_WIDTHS } from "./utils/layout.js";
import { shimmerText } from "./utils/shimmer.js";

const HEADLINE = "𝅘𝅥𝅮 composer";
const TAGLINE = "deterministic coding agent";
const HINT = "type /help to explore commands";
const CANVAS_WIDTH = PANEL_WIDTHS.welcome;

export class WelcomeAnimation extends Container {
	private intervalId: NodeJS.Timeout | null = null;
	private readonly textComponent: Text;
	private readonly onRenderRequest?: () => void;

	constructor(onRenderRequest?: () => void) {
		super();
		this.onRenderRequest = onRenderRequest;
		this.textComponent = new Text("", 0, 0);
		this.addChild(this.textComponent);
		this.startAnimation();
	}

	private startAnimation(): void {
		this.intervalId = setInterval(() => {
			this.updateFrame();
			this.onRenderRequest?.();
		}, 140);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private updateFrame(): void {
		const nowSeconds = Date.now() / 1000;
		const title = shimmerText(HEADLINE, {
			padding: 4,
			bandWidth: 3,
			sweepSeconds: 2.4,
			intensityScale: 0.8,
			baseColor: "#cbd5f5",
			highlightColor: "#ffffff",
			time: nowSeconds,
		});
		const subline = shimmerText(TAGLINE, {
			padding: 2,
			bandWidth: 2.5,
			sweepSeconds: 3,
			intensityScale: 0.6,
			baseColor: "#9ca3af",
			highlightColor: "#e2e8f0",
			time: nowSeconds + 0.35,
			bold: false,
		});
		const hint = chalk.hex("#64748b")(HINT);
		const lines = [
			centerLine(title),
			"",
			centerLine(subline),
			"",
			centerLine(hint),
		];
		this.textComponent.setText(lines.join("\n"));
	}
}

function centerLine(text: string): string {
	const width = visibleWidth(text);
	const padding = Math.max(0, Math.floor((CANVAS_WIDTH - width) / 2));
	return `${" ".repeat(padding)}${text}`;
}
