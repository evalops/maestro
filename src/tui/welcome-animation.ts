import { Container, Text, visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import { theme } from "../theme/theme.js";
import { PANEL_WIDTHS } from "./utils/layout.js";
import { shimmerText } from "./utils/shimmer.js";

const HEADLINE = "*  c o m p o s e r";
const TAGLINE = "deterministic coding agent";
const TIPS = [
	"Tab: autocomplete files  |  /help: commands  |  @: mention files",
];
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
		// Render first frame immediately so there's content before the timer fires
		this.updateFrame();
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

	setModelName(modelName: string): void {
		this.modelName = modelName;
	}

	private modelName = "";

	private updateFrame(): void {
		const nowSeconds = Date.now() / 1000;
		const title = shimmerText(HEADLINE, {
			padding: 4,
			bandWidth: 3,
			sweepSeconds: 2.4,
			intensityScale: 0.8,
			baseColor: "#c084fc",
			highlightColor: "#f5d0fe",
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

		// Model status line
		const modelStatus = this.modelName
			? theme.fg("muted", `model: ${this.modelName}`)
			: "";

		// Quick tips
		const tips = TIPS.map((tip) => chalk.hex("#64748b")(tip));

		const lines = [
			"",
			centerLine(title),
			"",
			centerLine(subline),
			"",
			modelStatus ? centerLine(modelStatus) : "",
			"",
			...tips.map(centerLine),
			"",
		].filter((line) => line !== undefined);
		this.textComponent.setText(lines.join("\n"));
	}
}

function centerLine(text: string): string {
	const width = visibleWidth(text);
	const padding = Math.max(0, Math.floor((CANVAS_WIDTH - width) / 2));
	return `${" ".repeat(padding)}${text}`;
}
