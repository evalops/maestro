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
import { isHelpRequest, parseSubcommand } from "./utils.js";

export interface ConfigCommandDeps {
	handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleImport: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleFramework: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleComposer: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleInit: (ctx: CommandExecutionContext) => void | Promise<void>;
	showInfo: (message: string) => void;
}

export function createConfigCommandHandler(deps: ConfigCommandDeps) {
	return async function handleConfigCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, rewriteContext, customContext } = parseSubcommand(
			ctx,
			"validate",
		);

		switch (subcommand) {
			case "validate":
			case "check":
			case "status":
				await deps.handleConfig(ctx);
				break;

			case "import":
			case "preset":
			case "presets":
				await deps.handleImport(rewriteContext("import"));
				break;

			case "framework":
			case "fw":
				await deps.handleFramework(rewriteContext("framework"));
				break;

			case "composer":
			case "persona":
			case "agent":
				await deps.handleComposer(rewriteContext("composer"));
				break;

			case "init":
			case "scaffold":
			case "setup":
				await deps.handleInit(rewriteContext("init"));
				break;

			case "sources":
			case "providers":
			case "env":
			case "files":
				// Pass to config handler with subcommand
				await deps.handleConfig(
					customContext(`/config ${subcommand}`, subcommand),
				);
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showConfigHelp(ctx);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showConfigHelp(ctx);
				}
		}
	};
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
