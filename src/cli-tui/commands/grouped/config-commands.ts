/**
 * Consolidated /cfg command handler.
 *
 * Combines: /config, /import, /framework, /composer, /init
 *
 * Usage:
 *   /cfg                    - Show configuration overview
 *   /cfg validate           - Validate configuration
 *   /cfg import [preset]    - Import configuration presets
 *   /cfg framework [id]     - Set/show default framework
 *   /cfg composer [name]    - Manage custom composer configs
 *   /cfg init [path]        - Create AGENTS.md scaffolding
 */

import type { CommandExecutionContext } from "../types.js";
import { createGroupedCommandHandler } from "./utils.js";

export interface ConfigCommandDeps {
	handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleImport: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleFramework: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleComposer: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleInit: (ctx: CommandExecutionContext) => void | Promise<void>;
	showInfo: (message: string) => void;
}

export function createConfigCommandHandler(deps: ConfigCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "validate",
		showHelp: showConfigHelp,
		routes: [
			{
				match: ["validate", "check", "status"],
				execute: ({ ctx }) => deps.handleConfig(ctx),
			},
			{
				match: ["import", "preset", "presets"],
				execute: ({ rewriteContext }) =>
					deps.handleImport(rewriteContext("import")),
			},
			{
				match: ["framework", "fw"],
				execute: ({ rewriteContext }) =>
					deps.handleFramework(rewriteContext("framework")),
			},
			{
				match: ["composer", "persona", "agent"],
				execute: ({ rewriteContext }) =>
					deps.handleComposer(rewriteContext("composer")),
			},
			{
				match: ["init", "scaffold", "setup"],
				execute: ({ rewriteContext }) =>
					deps.handleInit(rewriteContext("init")),
			},
			{
				match: ["sources", "providers", "env", "files"],
				execute: ({ subcommand, customContext }) =>
					deps.handleConfig(customContext(`/config ${subcommand}`, subcommand)),
			},
		],
	});
}

function showConfigHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Configuration Commands:
  /cfg                    Show configuration overview
  /cfg validate           Validate configuration
  /cfg sources            Show config sources
  /cfg providers          Show provider configuration
  /cfg env                Show environment variables
  /cfg import [preset]    Import configuration presets
  /cfg framework [id]     Set/show default framework
  /cfg composer [name]    Manage custom composer configs
  /cfg init [path]        Create AGENTS.md scaffolding

Direct shortcuts still work: /config, /import, /framework, /composer, /init`);
}
