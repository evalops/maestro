/**
 * DelegatingCommandHandlers — Adapter functions that build context objects
 * from shared TUI dependencies and delegate to external command handlers.
 *
 * These are thin wrappers with no own state. Each handler constructs a
 * context/options object from the provided deps and forwards the call.
 */

import type { Agent } from "../../agent/agent.js";
import {
	type ComposerRenderContext,
	handleComposerCommand as composerHandler,
} from "../commands/composer-handlers.js";
import { handleFrameworkCommand as frameworkHandler } from "../commands/framework-handlers.js";
import {
	type McpRenderContext,
	handleMcpCommand as mcpHandler,
} from "../commands/mcp-handlers.js";
import type { CommandExecutionContext } from "../commands/types.js";
import type { NotificationView } from "../notification-view.js";

// ─── Dependency Interface ────────────────────────────────────────────────────

export interface DelegatingHandlerDeps {
	/** Agent instance for state and prompt injection. */
	agent: Agent;
	/** Notification view for toasts and errors. */
	notificationView: NotificationView;
	/** Add a Markdown component to the chat container. */
	addMarkdown: (content: string) => void;
	/** Add a Text component preceded by a Spacer to the chat container. */
	addSpacedText: (content: string) => void;
	/** Request a TUI render cycle. */
	requestRender: () => void;
}

// ─── Handler Map ─────────────────────────────────────────────────────────────

export interface DelegatingCommandHandlerMap {
	handleGuardianCommand: (context: CommandExecutionContext) => Promise<void>;
	handleWorkflowCommand: (context: CommandExecutionContext) => Promise<void>;
	handleEnhancedUndoCommand: (
		context: CommandExecutionContext,
	) => Promise<void>;
	handleChangesCommand: (context: CommandExecutionContext) => Promise<void>;
	handleCheckpointCommand: (context: CommandExecutionContext) => Promise<void>;
	handleMemoryCommand: (context: CommandExecutionContext) => Promise<void>;
	handleModeCommand: (context: CommandExecutionContext) => Promise<void>;
	handleSourcesCommand: (context: CommandExecutionContext) => Promise<void>;
	handleFrameworkCommand: (context: CommandExecutionContext) => void;
	handleMcpCommand: (context: CommandExecutionContext) => void;
	handleComposerCommand: (context: CommandExecutionContext) => void;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDelegatingCommandHandlers(
	deps: DelegatingHandlerDeps,
): DelegatingCommandHandlerMap {
	/** Shared callback bag used by guardian, workflow, undo, changes, checkpoint, memory. */
	const sharedCallbacks = () => ({
		addContent: (content: string) => deps.addMarkdown(content),
		showError: (message: string) => deps.notificationView.showError(message),
		showInfo: (message: string) => deps.notificationView.showInfo(message),
		showSuccess: (message: string) =>
			deps.notificationView.showToast(message, "success"),
		requestRender: () => deps.requestRender(),
	});

	return {
		async handleGuardianCommand(context) {
			const { handleGuardianCommand: guardianHandler } = await import(
				"../commands/guardian-handlers.js"
			);
			await guardianHandler(context, {
				showSuccess: (msg) => deps.notificationView.showToast(msg, "success"),
				showWarning: (msg) => deps.notificationView.showToast(msg, "warn"),
				showError: (msg) => deps.notificationView.showError(msg),
				addContent: (content) => deps.addMarkdown(content),
				requestRender: () => deps.requestRender(),
			});
		},

		async handleWorkflowCommand(context) {
			const { handleWorkflowCommand } = await import(
				"../commands/workflow-handlers.js"
			);
			const toolMap = new Map(
				(deps.agent.state.tools ?? []).map((t) => [t.name, t]),
			);
			await handleWorkflowCommand({
				rawInput: context.rawInput,
				cwd: process.cwd(),
				tools: toolMap,
				...sharedCallbacks(),
			});
		},

		async handleEnhancedUndoCommand(context) {
			const { handleEnhancedUndoCommand } = await import(
				"../commands/undo-handlers.js"
			);
			handleEnhancedUndoCommand({
				rawInput: context.rawInput,
				...sharedCallbacks(),
			});
		},

		async handleChangesCommand(context) {
			const { handleChangesCommand } = await import(
				"../commands/undo-handlers.js"
			);
			handleChangesCommand({
				rawInput: context.rawInput,
				...sharedCallbacks(),
			});
		},

		async handleCheckpointCommand(context) {
			const { handleCheckpointCommand } = await import(
				"../commands/undo-handlers.js"
			);
			handleCheckpointCommand({
				rawInput: context.rawInput,
				...sharedCallbacks(),
			});
		},

		async handleMemoryCommand(context) {
			const { handleMemoryCommand } = await import(
				"../commands/memory-handlers.js"
			);
			handleMemoryCommand({
				rawInput: context.rawInput,
				cwd: process.cwd(),
				sessionId: deps.agent.state.session?.id,
				...sharedCallbacks(),
			});
		},

		async handleModeCommand(context) {
			const { createModeCommandHandler } = await import(
				"../commands/handlers/mode-handler.js"
			);
			const handler = createModeCommandHandler({
				onModeChange: (_mode, model) => {
					deps.notificationView.showToast(`Model: ${model}`, "info");
				},
			});
			handler(context);
		},

		async handleSourcesCommand(context) {
			try {
				const result = await deps.agent.getContextSourceStatus();
				const lines: string[] = ["Context Sources Status:"];
				lines.push(
					`  Total: ${result.successCount} success, ${result.failureCount} failed (${result.totalDurationMs}ms)`,
				);
				lines.push("");

				for (const source of result.sourceStatuses) {
					const icon =
						source.status === "success"
							? "✓"
							: source.status === "empty"
								? "○"
								: source.status === "skipped"
									? "⊘"
									: "✗";
					const status =
						source.status === "success"
							? source.truncated
								? `success (truncated from ${source.originalLength} chars)`
								: "success"
							: source.status;
					const duration =
						source.durationMs > 0 ? ` (${source.durationMs}ms)` : "";
					lines.push(`  ${icon} ${source.name}: ${status}${duration}`);
					if (source.error) {
						lines.push(`      Error: ${source.error}`);
					}
				}

				context.showInfo(lines.join("\n"));
			} catch (error) {
				context.showError(
					`Failed to get context source status: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},

		handleFrameworkCommand(context) {
			frameworkHandler(context, {
				showInfo: (msg) => deps.notificationView.showInfo(msg),
				showError: (msg) => deps.notificationView.showError(msg),
				showSuccess: (msg) => deps.notificationView.showToast(msg, "success"),
			});
		},

		handleMcpCommand(context) {
			const renderContext: McpRenderContext = {
				rawInput: context.rawInput,
				addContent: (content: string) => deps.addSpacedText(content),
				showError: (message: string) =>
					deps.notificationView.showError(message),
				requestRender: () => deps.requestRender(),
			};
			mcpHandler(renderContext);
		},

		handleComposerCommand(context) {
			const renderContext: ComposerRenderContext = {
				rawInput: context.rawInput,
				cwd: process.cwd(),
				addContent: (content: string) => deps.addSpacedText(content),
				requestRender: () => deps.requestRender(),
			};
			composerHandler(renderContext);
		},
	};
}
