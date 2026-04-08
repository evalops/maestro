import {
	formatKeybindingConfigReport,
	initializeKeybindingsFile,
	inspectKeybindingConfig,
} from "../keybindings-config.js";
import { resetTuiKeybindingConfigCache } from "../keybindings.js";
import {
	type SubcommandDef,
	createGroupedCommandHandler,
} from "./grouped/utils.js";
import type { CommandExecutionContext } from "./types.js";

export const HOTKEYS_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "show", description: "Show current keyboard shortcuts" },
	{ name: "path", description: "Show the keybindings config file path" },
	{ name: "init", description: "Create a starter keybindings.json file" },
	{ name: "validate", description: "Validate the current keybindings config" },
];

export interface HotkeysCommandDeps {
	showHotkeys: () => void;
}

export function createHotkeysCommandHandler(deps: HotkeysCommandDeps) {
	return createGroupedCommandHandler({
		defaultSubcommand: "show",
		showHelp: showHotkeysHelp,
		routes: [
			{
				match: ["show", "list", "help"],
				execute: () => deps.showHotkeys(),
			},
			{
				match: ["path", "where", "file"],
				execute: ({ ctx }) => {
					const report = inspectKeybindingConfig();
					ctx.showInfo(
						`Keyboard shortcuts config:\n  Path: ${report.path}\n  Status: ${report.exists ? "present" : "missing"}`,
					);
				},
			},
			{
				match: ["init", "create", "setup"],
				execute: ({ ctx, restArgs }) => {
					const force = restArgs.includes("--force");
					const result = initializeKeybindingsFile({ force });
					resetTuiKeybindingConfigCache();
					if (result.created) {
						ctx.showInfo(
							`Created keyboard shortcuts config at ${result.path}\nRun /hotkeys validate to verify the file after editing.`,
						);
						return;
					}
					ctx.showError(
						`Keybindings config already exists at ${result.path}. Re-run with /hotkeys init --force to overwrite it.`,
					);
				},
			},
			{
				match: ["validate", "check", "doctor", "status"],
				execute: ({ ctx }) => {
					ctx.showInfo(formatKeybindingConfigReport(inspectKeybindingConfig()));
				},
			},
		],
		onUnknown: ({ ctx, subcommand }) => {
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showHotkeysHelp(ctx);
		},
	});
}

function showHotkeysHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Hotkeys Commands:
  /hotkeys                  Show current keyboard shortcuts
  /hotkeys path             Show the keybindings config file path
  /hotkeys init [--force]   Create or overwrite a starter keybindings.json
  /hotkeys validate         Validate current TUI and Rust TUI overrides

Aliases: /keys, /shortcuts`);
}
