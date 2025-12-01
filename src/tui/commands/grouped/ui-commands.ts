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

export interface UiCommandDeps {
	handleTheme: (ctx: CommandExecutionContext) => void;
	handleClean: (ctx: CommandExecutionContext) => void;
	handleFooter: (ctx: CommandExecutionContext) => void;
	handleZen: (ctx: CommandExecutionContext) => void;
	handleCompactTools: (ctx: CommandExecutionContext) => void;
	showInfo: (message: string) => void;
	getUiState: () => {
		zenMode: boolean;
		cleanMode: string;
		footerMode: string;
		compactTools: boolean;
	};
}

export function createUiCommandHandler(deps: UiCommandDeps) {
	return function handleUiCommand(ctx: CommandExecutionContext): void {
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "status";

		const rewriteContext = (cmd: string): CommandExecutionContext => ({
			...ctx,
			rawInput: `/${cmd} ${args.slice(1).join(" ")}`.trim(),
			argumentText: args.slice(1).join(" "),
		});

		switch (subcommand) {
			case "status":
			case "info":
				showUiStatus(deps);
				break;

			case "theme":
			case "color":
			case "colors":
				deps.handleTheme(rewriteContext("theme"));
				break;

			case "clean":
			case "dedup":
				deps.handleClean(rewriteContext("clean"));
				break;

			case "footer":
				deps.handleFooter(rewriteContext("footer"));
				break;

			case "alerts":
			case "notifications":
				// Rewrite to footer command
				deps.handleFooter({
					...ctx,
					rawInput: `/footer ${args.slice(1).join(" ") || "history"}`,
					argumentText: args.slice(1).join(" ") || "history",
				});
				break;

			case "zen":
				deps.handleZen(rewriteContext("zen"));
				break;

			case "compact":
			case "fold":
				deps.handleCompactTools(rewriteContext("compact-tools"));
				break;

			case "help":
				showUiHelp(ctx);
				break;

			default:
				ctx.showError(`Unknown subcommand: ${subcommand}`);
				showUiHelp(ctx);
		}
	};
}

function showUiStatus(deps: UiCommandDeps): void {
	const state = deps.getUiState();
	deps.showInfo(`UI Settings:
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
