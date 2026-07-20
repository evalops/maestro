import { Container, Spacer, Text } from "@evalops/tui";
import { theme } from "../theme/theme.js";
import { formatRelativeTime } from "./utils/footer-utils.js";

/**
 * Lightweight transcript marker inserted when conversation history has been
 * compacted into a summary.
 */
export class CompactBoundaryMessageComponent extends Container {
	constructor(timestamp?: number) {
		super();
		this.addChild(new Spacer(1));
		const suffix =
			typeof timestamp === "number"
				? theme.fg("muted", ` · ${formatRelativeTime(timestamp)}`)
				: "";
		this.addChild(
			new Text(theme.fg("dim", `✻ Conversation compacted${suffix}`), 0, 0),
		);
	}
}
