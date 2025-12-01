/**
 * Consolidated /undo command handler.
 *
 * Combines: /undo, /redo, /checkpoint
 *
 * Usage:
 *   /undo                  - Undo last action
 *   /undo redo             - Redo last undone action
 *   /undo checkpoint [name] - Create/restore checkpoint
 *   /undo history          - Show undo/redo history
 */

import type { CommandExecutionContext } from "../types.js";

export interface UndoCommandDeps {
	handleUndo: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleRedo: (ctx: CommandExecutionContext) => Promise<void> | void;
	handleCheckpoint: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
	getUndoState: () => {
		canUndo: boolean;
		canRedo: boolean;
		undoCount: number;
		redoCount: number;
		checkpoints: string[];
	};
}

export function createUndoCommandHandler(deps: UndoCommandDeps) {
	return async function handleUndoCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const args = ctx.argumentText.trim().split(/\s+/);
		const subcommand = args[0]?.toLowerCase() || "undo";

		const rewriteContext = (cmd: string): CommandExecutionContext => ({
			...ctx,
			rawInput: `/${cmd} ${args.slice(1).join(" ")}`.trim(),
			argumentText: args.slice(1).join(" "),
		});

		switch (subcommand) {
			case "undo":
			case "back":
			case "revert":
				await deps.handleUndo(ctx);
				break;

			case "redo":
			case "forward":
				await deps.handleRedo(rewriteContext("redo"));
				break;

			case "checkpoint":
			case "save":
			case "snap":
			case "snapshot":
				await deps.handleCheckpoint(rewriteContext("checkpoint"));
				break;

			case "history":
			case "list":
				showUndoHistory(deps);
				break;

			case "help":
				showUndoHelp(ctx);
				break;

			default:
				// If argument looks like a checkpoint name, treat as checkpoint restore
				if (args[0] && !args[0].startsWith("-")) {
					await deps.handleCheckpoint({
						...ctx,
						rawInput: `/checkpoint restore ${ctx.argumentText}`,
						argumentText: `restore ${ctx.argumentText}`,
					});
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

	deps.showInfo(`Undo/Redo History:
  Can Undo: ${state.canUndo ? "yes" : "no"} (${state.undoCount} actions)
  Can Redo: ${state.canRedo ? "yes" : "no"} (${state.redoCount} actions)

Checkpoints:
${checkpointList}

Use /undo or /undo redo to navigate.`);
}

function showUndoHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Undo Commands:
  /undo                  Undo last action
  /undo redo             Redo last undone action
  /undo checkpoint [name] Create named checkpoint
  /undo checkpoint restore <name> Restore checkpoint
  /undo history          Show undo/redo history

Direct shortcuts still work: /redo, /checkpoint`);
}
