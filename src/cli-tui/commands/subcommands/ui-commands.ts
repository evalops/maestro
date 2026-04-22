/**
 * Consolidated /ui command handler.
 *
 * Combines: /theme, /clean, /footer, /alerts, /zen, /compact-tools
 *
 * Usage:
 *   /ui                   - Show current UI settings
 *   /ui theme             - Open theme selector
 *   /ui clean [mode]      - Toggle text deduplication (off|soft|aggressive)
 *   /ui footer [mode]     - Footer style (ensemble|solo|history|clear)
 *   /ui alerts [cmd]      - Alert management (history|clear)
 *   /ui zen [on|off]      - Toggle zen mode
 *   /ui compact [on|off]  - Toggle tool output folding
 */

import type { CommandExecutionContext } from "../types.js";
import { createSubcommandHandler } from "./utils.js";

export interface UiCommandDeps {
	handleTheme: (ctx: CommandExecutionContext) => void;
	handleClean: (ctx: CommandExecutionContext) => void;
	handleFooter: (ctx: CommandExecutionContext) => void;
	handleZen: (ctx: CommandExecutionContext) => void;
	handleCompactTools: (ctx: CommandExecutionContext) => void;
	getUiState: () => {
		zenMode: boolean;
		cleanMode: string;
		footerMode: string;
		compactTools: boolean;
	};
}

export function createUiCommandHandler(deps: UiCommandDeps) {
	return createSubcommandHandler({
		defaultSubcommand: "status",
		showHelp: showUiHelp,
		routes: [
			{
				match: ["status", "info"],
				execute: ({ ctx }) => showUiStatus(ctx, deps),
			},
			{
				match: ["theme", "color", "colors"],
				execute: ({ rewriteContext }) =>
					deps.handleTheme(rewriteContext("theme")),
			},
			{
				match: ["clean", "dedup"],
				execute: ({ rewriteContext }) =>
					deps.handleClean(rewriteContext("clean")),
			},
			{
				match: ["footer"],
				execute: ({ rewriteContext }) =>
					deps.handleFooter(rewriteContext("footer")),
			},
			{
				match: ["alerts", "notifications"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleFooter(
						customContext(
							`/footer ${restArgumentText || "history"}`,
							restArgumentText || "history",
						),
					),
			},
			{
				match: ["zen"],
				execute: ({ rewriteContext }) => deps.handleZen(rewriteContext("zen")),
			},
			{
				match: ["compact", "fold"],
				execute: ({ rewriteContext }) =>
					deps.handleCompactTools(rewriteContext("compact-tools")),
			},
		],
	});
}

function showUiStatus(ctx: CommandExecutionContext, deps: UiCommandDeps): void {
	const state = deps.getUiState();
	ctx.showInfo(`UI Settings:
  Zen Mode: ${state.zenMode ? "on" : "off"}
  Clean Mode: ${state.cleanMode}
  Footer: ${state.footerMode}
  Compact Tools: ${state.compactTools ? "on" : "off"}

Use /ui <setting> to change a setting.`);
}

function showUiHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`UI Commands:
  /ui                   Show current UI settings
  /ui theme             Open theme selector
  /ui clean [mode]      Text deduplication (off|soft|aggressive)
  /ui footer [mode]     Footer style (ensemble|solo)
  /ui alerts [cmd]      Alerts (history|clear)
  /ui zen [on|off]      Toggle zen mode
  /ui compact [on|off]  Toggle tool output folding

Direct shortcuts still work: /theme, /zen, /footer`);
}
