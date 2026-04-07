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
import { createGroupedCommandHandler, isNumericArg } from "./utils.js";

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
	return createGroupedCommandHandler({
		defaultSubcommand: "undo",
		showHelp: showUndoHelp,
		routes: [
			{
				match: ["undo", "back", "revert"],
				execute: ({ ctx }) => deps.handleUndo(ctx),
			},
			{
				match: ["checkpoint", "save", "snap", "snapshot"],
				execute: ({ rewriteContext }) =>
					deps.handleCheckpoint(rewriteContext("checkpoint")),
			},
			{
				match: ["changes", "files", "tracked"],
				execute: ({ customContext, restArgumentText }) =>
					deps.handleChanges(
						customContext(`/changes ${restArgumentText}`, restArgumentText),
					),
			},
			{
				match: ["history", "list", "status"],
				execute: () => showUndoHistory(deps),
			},
		],
		onUnknown: async ({ ctx, subcommand, args, customContext }) => {
			if (isNumericArg(subcommand)) {
				await deps.handleUndo(customContext(`/undo ${subcommand}`, subcommand));
				return;
			}
			if (args[0] && !args[0].startsWith("-")) {
				await deps.handleCheckpoint(
					customContext(
						`/checkpoint restore ${ctx.argumentText}`,
						`restore ${ctx.argumentText}`,
					),
				);
				return;
			}
			ctx.showError(`Unknown subcommand: ${subcommand}`);
			showUndoHelp(ctx);
		},
	});
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
