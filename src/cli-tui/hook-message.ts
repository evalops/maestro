import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
} from "@evalops/tui";
import type { HookMessage } from "../agent/types.js";
import type { HookMessageRenderer } from "../hooks/types.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { BorderedBox } from "./utils/borders.js";

function extractHookMessageText(message: HookMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((chunk) => chunk.type === "text")
		.map((chunk) => chunk.text)
		.join("\n");
}

/**
 * Component that renders a hook-injected message.
 */
export class HookMessageComponent extends Container {
	constructor(
		private readonly message: HookMessage,
		private readonly customRenderer?: HookMessageRenderer,
	) {
		super();
		this.addChild(new Spacer(1));
		this.renderContent();
	}

	private renderContent(): void {
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: true },
					theme,
				);
				if (component) {
					this.addChild(component);
					return;
				}
			} catch {
				// Fall back to default rendering
			}
		}

		const inner = new Container();
		const label = theme.fg(
			"accent",
			`\x1b[1m[${this.message.customType}]\x1b[22m`,
		);
		inner.addChild(new Text(label, 0, 0));
		inner.addChild(new Spacer(1));

		const text = extractHookMessageText(this.message).trim() || "(no content)";
		inner.addChild(
			new Markdown(
				text,
				undefined,
				undefined,
				undefined,
				0,
				0,
				getMarkdownTheme(),
			),
		);

		const boxed: Component = new BorderedBox(inner, {
			color: "borderMuted",
			style: "rounded",
		});
		this.addChild(boxed);
	}
}
