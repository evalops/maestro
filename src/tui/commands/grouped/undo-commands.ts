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

			case "checkpoint":
			case "save":
			case "snap":
			case "snapshot":
				await deps.handleCheckpoint(rewriteContext("checkpoint"));
				break;

			case "changes":
			case "files":
			case "tracked":
				deps.handleChanges({
					...ctx,
					rawInput: `/changes ${args.slice(1).join(" ")}`,
					argumentText: args.slice(1).join(" "),
				});
				break;

			case "history":
			case "list":
			case "status":
				showUndoHistory(deps);
				break;

			case "help":
				showUndoHelp(ctx);
				break;

			default:
				// If argument is a number, treat as undo N
				if (/^\d+$/.test(subcommand)) {
					await deps.handleUndo({
						...ctx,
						rawInput: `/undo ${subcommand}`,
						argumentText: subcommand,
					});
				}
				// If argument looks like a checkpoint name, treat as checkpoint restore
				else if (args[0] && !args[0].startsWith("-")) {
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
