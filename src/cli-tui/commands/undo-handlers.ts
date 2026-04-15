/**
 * Enhanced undo command handlers for TUI.
 *
 * Provides:
 * - /undo [N] [--preview] [--force] - Undo last N changes
 * - /changes [--files|--tools] - List file changes
 * - /checkpoint [save|list|restore] - Checkpoint management
 */

import chalk from "chalk";
import { getCheckpointService } from "../../checkpoints/index.js";
import { getChangeTracker } from "../../undo/index.js";
import type { FileChange } from "../../undo/types.js";

export interface UndoRenderContext {
	rawInput: string;
	addContent(content: string): void;
	showError(message: string): void;
	showInfo(message: string): void;
	showSuccess(message: string): void;
	requestRender(): void;
}

/**
 * Format a timestamp as relative time.
 */
function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60000) return "just now";
	if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
	if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
	return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Format a file path for display (truncate if too long).
 */
function formatPath(path: string, maxLen = 50): string {
	if (path.length <= maxLen) return path;
	return `...${path.slice(-(maxLen - 3))}`;
}

/**
 * Handle the enhanced /undo command.
 */
export function handleEnhancedUndoCommand(ctx: UndoRenderContext): void {
	const args = ctx.rawInput.replace(/^\/undo\s*/, "").trim();
	const parts = args.split(/\s+/).filter(Boolean);

	const isPreview = parts.includes("--preview") || parts.includes("-p");
	const isForce = parts.includes("--force") || parts.includes("-f");
	const countArg = parts.find((p) => /^\d+$/.test(p));
	const count = countArg ? Number.parseInt(countArg, 10) : 1;

	const tracker = getChangeTracker();
	const stats = tracker.getStats();

	if (stats.totalChanges === 0) {
		const checkpointSvc = getCheckpointService();
		if (checkpointSvc?.canUndo()) {
			if (isPreview) {
				const history = checkpointSvc.getHistory();
				const lastCheckpoint = history.at(-1);
				if (!lastCheckpoint) {
					ctx.showInfo("No checkpoints available to undo.");
				} else {
					const lines = [
						"Checkpoint Undo Preview",
						"",
						`Would restore ${lastCheckpoint.fileCount} file${lastCheckpoint.fileCount === 1 ? "" : "s"} to state before "${lastCheckpoint.description}"`,
						chalk.dim("Run /undo to apply"),
					];
					ctx.addContent(lines.join("\n"));
					ctx.requestRender();
				}
			} else {
				const result = checkpointSvc.undo();
				if (result.success) {
					const restored = result.files?.length ?? 0;
					ctx.showSuccess(
						`Restored ${restored} file${restored === 1 ? "" : "s"} from last checkpoint.`,
					);
				} else {
					ctx.showError(result.message);
				}
			}
		} else {
			ctx.showInfo(
				"No changes to undo. File changes are tracked during this session.",
			);
		}
		return;
	}

	if (isPreview) {
		const preview = tracker.previewUndo(count);

		if (preview.changes.length === 0) {
			ctx.showInfo("No changes to undo.");
			return;
		}

		const lines = [
			`Undo Preview (${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"})`,
			"",
		];

		for (const change of preview.changes) {
			const icon =
				change.type === "create"
					? chalk.green("+")
					: change.type === "delete"
						? chalk.red("-")
						: chalk.yellow("~");
			const action =
				change.type === "create"
					? "would delete"
					: change.type === "delete"
						? "would restore"
						: "would revert";
			lines.push(
				`  ${icon} ${formatPath(change.path)} ${chalk.dim(`(${action})`)}`,
			);
		}

		if (preview.conflicts.length > 0) {
			lines.push("", chalk.yellow("Conflicts:"));
			for (const conflict of preview.conflicts) {
				lines.push(`  ${chalk.red("!")} ${conflict.path}: ${conflict.reason}`);
			}
			lines.push("", chalk.dim("Use --force to override conflicts"));
		}

		lines.push("", chalk.dim(`Run /undo ${count} to apply`));

		ctx.addContent(lines.join("\n"));
		ctx.requestRender();
		return;
	}

	// Perform the undo
	const result = tracker.undo(count, isForce);

	if (result.undone === 0 && result.errors.length > 0) {
		ctx.showError(`Undo failed:\n${result.errors.join("\n")}`);
		return;
	}

	if (result.undone > 0) {
		let message = `Undid ${result.undone} change${result.undone === 1 ? "" : "s"}`;
		if (result.skipped > 0) {
			message += ` (${result.skipped} skipped)`;
		}
		ctx.showSuccess(message);
	} else {
		ctx.showInfo("No changes were undone.");
	}

	if (result.errors.length > 0) {
		ctx.addContent(
			chalk.yellow("Warnings:\n") +
				result.errors.map((e) => `  ${e}`).join("\n"),
		);
		ctx.requestRender();
	}
}

/**
 * Handle the /changes command.
 */
export function handleChangesCommand(ctx: UndoRenderContext): void {
	const args = ctx.rawInput.replace(/^\/changes\s*/, "").trim();
	const groupByFiles = args.includes("--files") || args.includes("-f");
	const groupByTools = args.includes("--tools") || args.includes("-t");

	const tracker = getChangeTracker();
	const changes = tracker.getChanges();
	const stats = tracker.getStats();

	if (changes.length === 0) {
		ctx.showInfo(
			"No file changes tracked yet. Changes are recorded when tools modify files.",
		);
		return;
	}

	const lines = [`File Changes (${changes.length} total)`, ""];

	if (groupByFiles) {
		// Group by file path
		const byPath = new Map<string, FileChange[]>();
		for (const change of changes) {
			const existing = byPath.get(change.path) ?? [];
			existing.push(change);
			byPath.set(change.path, existing);
		}

		for (const [path, fileChanges] of byPath) {
			lines.push(chalk.cyan(formatPath(path, 60)));
			for (const change of fileChanges) {
				const icon =
					change.type === "create"
						? chalk.green("+")
						: change.type === "delete"
							? chalk.red("-")
							: chalk.yellow("~");
				lines.push(
					`  ${icon} ${change.type} by ${change.toolName} ${chalk.dim(formatRelativeTime(change.timestamp))}`,
				);
			}
		}
	} else if (groupByTools) {
		// Group by tool
		for (const [tool, count] of Object.entries(stats.byTool)) {
			const toolChanges = changes.filter((c) => c.toolName === tool);
			lines.push(`${chalk.cyan(tool)} (${count} changes)`);
			for (const change of toolChanges.slice(-5)) {
				const icon =
					change.type === "create"
						? chalk.green("+")
						: change.type === "delete"
							? chalk.red("-")
							: chalk.yellow("~");
				lines.push(
					`  ${icon} ${formatPath(change.path, 45)} ${chalk.dim(formatRelativeTime(change.timestamp))}`,
				);
			}
			if (toolChanges.length > 5) {
				lines.push(chalk.dim(`  ... and ${toolChanges.length - 5} more`));
			}
		}
	} else {
		// Chronological list (newest first)
		const recent = changes.slice(-15).reverse();
		for (let i = 0; i < recent.length; i++) {
			const change = recent[i];
			if (!change) continue;
			const icon =
				change.type === "create"
					? chalk.green("+")
					: change.type === "delete"
						? chalk.red("-")
						: chalk.yellow("~");
			const num = chalk.dim(`${i + 1}.`);
			lines.push(
				`${num} ${icon} [${change.toolName}] ${formatPath(change.path, 40)} ${chalk.dim(formatRelativeTime(change.timestamp))}`,
			);
		}
		if (changes.length > 15) {
			lines.push(chalk.dim(`... and ${changes.length - 15} older changes`));
		}
	}

	lines.push("");
	lines.push(
		chalk.dim(
			`Types: ${stats.byType.create} created, ${stats.byType.modify} modified, ${stats.byType.delete} deleted`,
		),
	);
	lines.push(chalk.dim("Use /undo N to undo last N changes"));

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

/**
 * Handle the /checkpoint command.
 */
export function handleCheckpointCommand(ctx: UndoRenderContext): void {
	const args = ctx.rawInput.replace(/^\/checkpoint\s*/, "").trim();
	const parts = args.split(/\s+/).filter(Boolean);
	const subcommand = parts[0]?.toLowerCase() || "list";

	const tracker = getChangeTracker();

	switch (subcommand) {
		case "save": {
			const name = parts[1];
			if (!name) {
				ctx.showError("Usage: /checkpoint save <name> [description]");
				return;
			}
			const description = parts.slice(2).join(" ") || undefined;
			const checkpoint = tracker.createCheckpoint(name, description);
			ctx.showSuccess(
				`Checkpoint "${name}" saved at ${checkpoint.changeCount} changes`,
			);
			break;
		}

		case "list":
		case "ls": {
			const checkpoints = tracker.getCheckpoints();
			if (checkpoints.length === 0) {
				ctx.showInfo(
					"No checkpoints saved. Use /checkpoint save <name> to create one.",
				);
				return;
			}

			const lines = ["Checkpoints", ""];
			for (const cp of checkpoints) {
				lines.push(
					`  ${chalk.cyan(cp.name)} - ${cp.changeCount} changes ${chalk.dim(formatRelativeTime(cp.timestamp))}`,
				);
				if (cp.description) {
					lines.push(`    ${chalk.dim(cp.description)}`);
				}
			}
			lines.push("");
			lines.push(chalk.dim("Use /checkpoint restore <name> to restore"));

			ctx.addContent(lines.join("\n"));
			ctx.requestRender();
			break;
		}

		case "restore": {
			const name = parts[1];
			if (!name) {
				ctx.showError("Usage: /checkpoint restore <name> [--force]");
				return;
			}
			const force = parts.includes("--force") || parts.includes("-f");
			const result = tracker.restoreCheckpoint(name, force);

			if (result.errors.length > 0 && result.undone === 0) {
				ctx.showError(`Restore failed:\n${result.errors.join("\n")}`);
				return;
			}

			ctx.showSuccess(
				`Restored to checkpoint "${name}" (${result.undone} changes undone)`,
			);
			break;
		}

		case "delete":
		case "rm": {
			const name = parts[1];
			if (!name) {
				ctx.showError("Usage: /checkpoint delete <name>");
				return;
			}
			// Note: Would need to add a delete method to tracker
			ctx.showInfo("Checkpoint deletion not yet implemented");
			break;
		}

		default:
			handleCheckpointHelp(ctx);
	}
}

function handleCheckpointHelp(ctx: UndoRenderContext): void {
	const lines = [
		"Checkpoint Commands",
		"",
		"  /checkpoint list              List all checkpoints",
		"  /checkpoint save <name>       Save current state as checkpoint",
		"  /checkpoint restore <name>    Restore to a checkpoint",
		"",
		"Checkpoints mark a point in the change history.",
		"Restoring undoes all changes made after the checkpoint.",
	];

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}
