import chalk from "chalk";
import { Container, Spacer, Text, visibleWidth } from "../tui-lib/index.js";

type ShellBlockStatus = "pending" | "success" | "error";

const BORDER_COLOR = "#475569";
const LABEL_COLOR = "#7dd3fc";
const PATH_COLOR = "#cbd5f5";
const BG_COLORS: Record<ShellBlockStatus, { r: number; g: number; b: number }> =
	{
		pending: { r: 14, g: 18, b: 28 },
		success: { r: 13, g: 24, b: 20 },
		error: { r: 32, g: 12, b: 18 },
	};

/**
 * Visually styled block that mimics a shell prompt/output panel.
 */
export class BashShellBlock extends Container {
	private readonly panelWidth: number;
	private readonly title: string;
	private content: Text;

	constructor(title: string, initialBody: string) {
		super();
		this.title = title;
		this.panelWidth = Math.min(80, Math.max(42, visibleWidth(title) + 28));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.buildTopLine(), 1, 0));
		this.content = new Text(initialBody, 1, 1, BG_COLORS.pending);
		this.addChild(this.content);
		this.addChild(new Text(this.buildBottomLine(), 1, 0));
	}

	setBody(text: string): void {
		this.content.setText(text);
	}

	setStatus(status: ShellBlockStatus): void {
		this.content.setCustomBgRgb(BG_COLORS[status]);
	}

	private buildTopLine(): string {
		const label = chalk.hex(LABEL_COLOR).bold("bash");
		const meta = chalk.hex(PATH_COLOR)(this.title);
		const header = `${label} ${meta}`;
		const decorativeWidth = Math.max(
			0,
			this.panelWidth - visibleWidth(header) - 4,
		);
		return chalk.hex(BORDER_COLOR)(
			`╭ ${header} ${"─".repeat(decorativeWidth)}╮`,
		);
	}

	private buildBottomLine(): string {
		return chalk.hex(BORDER_COLOR)(`╰${"─".repeat(this.panelWidth - 2)}╯`);
	}
}
