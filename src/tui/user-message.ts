import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;

	constructor(text: string, isFirst: boolean) {
		super();

		// Add spacer before user message (except first one)
		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const accent = chalk.hex("#63d9ff")("▍");
		const badge = chalk.hex("#9ea3ff")("you");
		this.addChild(new Text(`${accent} ${badge}`, 1, 0));

		// User messages with dark gray background
		this.markdown = new Markdown(text, undefined, undefined, {
			r: 42,
			g: 44,
			b: 58,
		});
		this.addChild(this.markdown);
		this.addChild(new Text(chalk.hex("#293041")("┈".repeat(36)), 1, 0));
	}
}
