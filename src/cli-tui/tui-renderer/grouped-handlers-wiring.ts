/**
 * GroupedHandlersWiring — Builds the GroupedCommandDeps object that wires
 * TuiRenderer's sub-controllers/views to the grouped command handler system.
 *
 * No own state. Pure mapping from TuiRenderer-level refs to GroupedCommandDeps.
 */

import {
	type GroupedCommandHandlers,
	createGroupedCommandHandlers,
} from "../commands/grouped-command-handlers.js";
import { handleOtelCommand as otelHandler } from "../commands/otel-handlers.js";
import {
	type ApprovalService,
	handleApprovalsCommand,
	handlePlanModeCommand,
} from "../commands/safety-handlers.js";
import type { CommandExecutionContext } from "../commands/types.js";
import { handleInitCommand } from "../commands/utility-handlers.js";
import type { NotificationView } from "../notification-view.js";
import type { DelegatingCommandHandlerMap } from "./delegating-command-handlers.js";

// ─── Dependency Interface ────────────────────────────────────────────────────

export interface GroupedWiringDeps {
	/** Delegating command handler map (guardian, workflow, undo, etc.). */
	delegatingHandlers: DelegatingCommandHandlerMap;
	/** Notification view for toasts and errors. */
	notificationView: NotificationView;
	/** Approval service for safety commands. */
	approvalService: ApprovalService;
	/** Request a TUI render cycle. */
	requestRender: () => void;
	/** Refresh footer hints. */
	refreshFooterHint: () => void;
	/** Add a spaced text component to the chat container. */
	addSpacedText: (text: string) => void;

	// ── Session ──
	handleNewChatCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleClearCommand: () => void | Promise<void>;
	handleSessionCommand: (rawInput: string) => void | Promise<void>;
	handleSessionsCommand: (rawInput: string) => void | Promise<void>;
	handleBranchCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	showTree: () => void;
	handleQueueCommand: ((ctx: CommandExecutionContext) => void) | null;
	handleExportCommand: (rawInput: string) => void | Promise<void>;
	handleShareCommand: (rawInput: string) => void | Promise<void>;
	handleSessionRecoverCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	handleSessionCleanupCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;

	// ── Diag ──
	handleStatusCommand: () => void | Promise<void>;
	handleAboutCommand: () => void | Promise<void>;
	handleContextCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleStatsCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleBackgroundCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	handleDiagnosticsCommand: (rawInput: string) => void | Promise<void>;
	handleTelemetryCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	handleTrainingCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleConfigCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleLspCommand: (rawInput: string) => void | Promise<void>;
	handlePerfCommand: () => void;

	// ── UI ──
	showTheme: () => void;
	handleCleanCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleFooterCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleZenCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleCompactToolsCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	getUiState: () => {
		zenMode: boolean;
		cleanMode: string;
		footerMode: string;
		compactTools: boolean;
	};

	// ── Git ──
	handleDiffCommand: (rawInput: string) => void | Promise<void>;
	handleReviewCommand: (ctx: CommandExecutionContext) => void | Promise<void>;

	// ── Auth ──
	handleLoginCommand: (
		argumentText: string,
		showError: (msg: string) => void,
	) => void | Promise<void>;
	handleLogoutCommand: (
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	) => void | Promise<void>;
	handleAuthSourceOfTruthCommand: (
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	) => void | Promise<void>;
	getAuthState: () => {
		authenticated: boolean;
		provider?: string;
		mode?: string;
	};

	// ── Usage ──
	handleCostCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handleQuotaCommand: (ctx: CommandExecutionContext) => void | Promise<void>;

	// ── Config ──
	handleImportCommand: (rawInput: string) => void | Promise<void>;

	// ── Tools ──
	handleToolsCommand: (rawInput: string) => void | Promise<void>;
	handleRunCommand: (rawInput: string) => void | Promise<void>;
	handleCommandsCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build grouped command handlers from TuiRenderer-level references.
 */
export function buildGroupedCommandHandlers(
	deps: GroupedWiringDeps,
): GroupedCommandHandlers {
	/** Shared rendering callbacks for safety commands. */
	const safetyCallbacks = () => ({
		showToast: (msg: string, type: "success" | "info") =>
			deps.notificationView.showToast(msg, type),
		refreshFooterHint: () => deps.refreshFooterHint(),
		addContent: (text: string) => deps.addSpacedText(text),
		requestRender: () => deps.requestRender(),
	});

	return createGroupedCommandHandlers({
		session: {
			handleNewChat: (ctx) => deps.handleNewChatCommand(ctx),
			handleClear: () => deps.handleClearCommand(),
			handleSessionInfo: (ctx) => deps.handleSessionCommand(ctx.rawInput),
			handleSessionsList: (ctx) => deps.handleSessionsCommand(ctx.rawInput),
			handleBranch: (ctx) => deps.handleBranchCommand(ctx),
			handleTree: () => deps.showTree(),
			handleQueue: (ctx) => {
				if (deps.handleQueueCommand) {
					deps.handleQueueCommand(ctx);
					return;
				}
				ctx.showInfo("Prompt queue is not available.");
			},
			handleExport: (ctx) => deps.handleExportCommand(ctx.rawInput),
			handleShare: (ctx) => deps.handleShareCommand(ctx.rawInput),
			handleRecover: (ctx) => deps.handleSessionRecoverCommand(ctx),
			handleCleanup: (ctx) => deps.handleSessionCleanupCommand(ctx),
		},
		diag: {
			handleStatus: () => deps.handleStatusCommand(),
			handleAbout: () => deps.handleAboutCommand(),
			handleContext: (ctx) => deps.handleContextCommand(ctx),
			handleStats: (ctx) => deps.handleStatsCommand(ctx),
			handleBackground: (ctx) => deps.handleBackgroundCommand(ctx),
			handleDiagnostics: (ctx) => deps.handleDiagnosticsCommand(ctx.rawInput),
			handleTelemetry: (ctx) => deps.handleTelemetryCommand(ctx),
			handleTraining: (ctx) => deps.handleTrainingCommand(ctx),
			handleOtel: () =>
				otelHandler({
					showInfo: (msg) => deps.notificationView.showInfo(msg),
				}),
			handleConfig: (ctx) => deps.handleConfigCommand(ctx),
			handleLsp: (ctx) => deps.handleLspCommand(ctx.rawInput),
			handleMcp: (ctx) => deps.delegatingHandlers.handleMcpCommand(ctx),
			handleSources: (ctx) => deps.delegatingHandlers.handleSourcesCommand(ctx),
			handlePerf: () => deps.handlePerfCommand(),
		},
		ui: {
			showTheme: () => deps.showTheme(),
			handleClean: (ctx) => deps.handleCleanCommand(ctx),
			handleFooter: (ctx) => deps.handleFooterCommand(ctx),
			handleZen: (ctx) => deps.handleZenCommand(ctx),
			handleCompactTools: (ctx) => deps.handleCompactToolsCommand(ctx),
			getUiState: () => deps.getUiState(),
		},
		safety: {
			handleApprovals: (ctx) =>
				handleApprovalsCommand(ctx, deps.approvalService, safetyCallbacks()),
			handlePlanMode: (ctx) => handlePlanModeCommand(ctx, safetyCallbacks()),
			handleGuardian: (ctx) =>
				deps.delegatingHandlers.handleGuardianCommand(ctx),
			getSafetyState: () => ({
				approvalMode: process.env.MAESTRO_APPROVALS ?? "prompt",
				planMode: process.env.MAESTRO_PLAN_MODE === "1",
				guardianEnabled: true,
			}),
		},
		git: {
			handleDiff: (ctx) => deps.handleDiffCommand(ctx.rawInput),
			handleReview: (ctx) => deps.handleReviewCommand(ctx),
			runGitCommand: async (cmd: string) => {
				const { execSync } = await import("node:child_process");
				return execSync(cmd, { encoding: "utf-8" });
			},
		},
		auth: {
			handleLogin: (ctx) =>
				deps.handleLoginCommand(ctx.argumentText, (msg) => ctx.showError(msg)),
			handleLogout: (ctx) =>
				deps.handleLogoutCommand(
					ctx.argumentText,
					(msg) => ctx.showError(msg),
					(msg) => ctx.showInfo(msg),
				),
			handleSourceOfTruthPolicy: (ctx) =>
				deps.handleAuthSourceOfTruthCommand(
					ctx.argumentText,
					(msg) => ctx.showError(msg),
					(msg) => ctx.showInfo(msg),
				),
			getAuthState: () => deps.getAuthState(),
		},
		usage: {
			handleCost: (ctx) => deps.handleCostCommand(ctx),
			handleQuota: (ctx) => deps.handleQuotaCommand(ctx),
			handleStats: (ctx) => deps.handleStatsCommand(ctx),
		},
		undo: {
			handleUndo: (ctx) =>
				deps.delegatingHandlers.handleEnhancedUndoCommand(ctx),
			handleCheckpoint: (ctx) =>
				deps.delegatingHandlers.handleCheckpointCommand(ctx),
			handleChanges: (ctx) => deps.delegatingHandlers.handleChangesCommand(ctx),
			getUndoState: () => ({
				canUndo: true,
				undoCount: 0,
				checkpoints: [],
			}),
		},
		config: {
			handleConfig: (ctx) => deps.handleConfigCommand(ctx),
			handleImport: (ctx) => deps.handleImportCommand(ctx.rawInput),
			handleFramework: (ctx) =>
				deps.delegatingHandlers.handleFrameworkCommand(ctx),
			handleComposer: (ctx) =>
				deps.delegatingHandlers.handleComposerCommand(ctx),
			handleInit: (ctx) =>
				handleInitCommand(ctx, {
					showSuccess: (msg) => deps.notificationView.showToast(msg, "success"),
					showError: (msg) => ctx.showError(msg),
					addContent: (text) => deps.addSpacedText(text),
					requestRender: () => deps.requestRender(),
				}),
		},
		tools: {
			handleTools: (ctx) => deps.handleToolsCommand(ctx.rawInput),
			handleMcp: (ctx) => deps.delegatingHandlers.handleMcpCommand(ctx),
			handleLsp: (ctx) => deps.handleLspCommand(ctx.rawInput),
			handleWorkflow: (ctx) =>
				deps.delegatingHandlers.handleWorkflowCommand(ctx),
			handleRun: (ctx) => deps.handleRunCommand(ctx.rawInput),
			handleCommands: (ctx) => deps.handleCommandsCommand(ctx),
		},
	});
}
