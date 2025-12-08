/**
 * Grouped /undo command handler.
 *
 * Combines: /undo, /checkpoint, /changes
 *
 * Usage:
 *   /undo                  - Undo last action
 *   /undo [N]              - Undo last N actions
 *   /undo checkpoint [name] - Create/restore checkpoint
 *   /undo changes          - List tracked file changes
 *   /undo history          - Show undo/redo history
 */

import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, isNumericArg, parseSubcommand } from "./utils.js";

export interface UndoCommandDeps {
	handleUndo: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleCheckpoint: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleChanges: (ctx: CommandExecutionContext) => void;
	showInfo: (message: string) => void;
	getUndoState: () => {
		canUndo: boolean;
		undoCount: number;
		checkpoints: string[];
	};
}

export function createUndoCommandHandler(deps: UndoCommandDeps) {
	return async function handleUndoCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, args, rewriteContext, customContext } = parseSubcommand(
			ctx,
			"undo",
		);

		switch (subcommand) {
			case "undo":
			case "back":
			case "revert":
				await deps.handleUndo(ctx);
				break;

			case "checkpoint":
			case "save":
			case "snap":
			case "snapshot":
				await deps.handleCheckpoint(rewriteContext("checkpoint"));
				break;

			case "changes":
			case "files":
			case "tracked":
				deps.handleChanges(
					customContext(
						`/changes ${args.slice(1).join(" ")}`,
						args.slice(1).join(" "),
					),
				);
				break;

			case "history":
			case "list":
			case "status":
				showUndoHistory(deps);
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showUndoHelp(ctx);
				}
				// If argument is a number, treat as undo N
				else if (isNumericArg(subcommand)) {
					await deps.handleUndo(
						customContext(`/undo ${subcommand}`, subcommand),
					);
				}
				// If argument looks like a checkpoint name, treat as checkpoint restore
				else if (args[0] && !args[0].startsWith("-")) {
					await deps.handleCheckpoint(
						customContext(
							`/checkpoint restore ${ctx.argumentText}`,
							`restore ${ctx.argumentText}`,
						),
					);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showUndoHelp(ctx);
				}
		}
	};
}

function showUndoHistory(deps: UndoCommandDeps): void {
	const state = deps.getUndoState();
	const checkpointList =
		state.checkpoints.length > 0
			? state.checkpoints.map((c) => `  - ${c}`).join("\n")
			: "  (none)";

	deps.showInfo(`Undo Status:
  Can Undo: ${state.canUndo ? "yes" : "no"} (${state.undoCount} tracked changes)

Checkpoints:
${checkpointList}

Use /undo or /undo <N> to revert changes.`);
}

function showUndoHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Undo Commands:
  /undo                  Undo last action
  /undo <N>              Undo last N actions
  /undo checkpoint [name] Create named checkpoint
  /undo checkpoint restore <name> Restore checkpoint
  /undo changes          List tracked file changes
  /undo history          Show undo status and checkpoints

Direct shortcuts still work: /checkpoint, /changes`);
}
