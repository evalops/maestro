import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	private message: string;
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI;

	constructor(ui: TUI, message: string = "Loading...") {
        super("", 1, 0);
        this.message = message;
        this.ui = ui;
        this.start();
    }
    render(width: number): string[] {
        return ["", ...super.render(width)];
    }
    start(): void {
        this.updateDisplay();
        this.intervalId = setInterval(() => {
            this.currentFrame = (this.currentFrame + 1) % this.frames.length;
            this.updateDisplay();
        }, 80);
    }
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    setMessage(message: string): void {
        this.message = message;
        this.updateDisplay();
    }
    private updateDisplay(): void {
        const frame = this.frames[this.currentFrame];
        this.setText(`${chalk.cyan(frame)} ${chalk.dim(this.message)}`);
        if (this.ui) {
            this.ui.requestRender();
        }
    }
}
