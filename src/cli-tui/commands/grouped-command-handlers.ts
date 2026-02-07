import { isDatabaseConfigured } from "../../db/client.js";
import type { CommandExecutionContext } from "./types.js";

export type GroupedCommandHandlers = {
	handleSession(context: CommandExecutionContext): Promise<void>;
	handleDiag(context: CommandExecutionContext): Promise<void>;
	handleUi(context: CommandExecutionContext): Promise<void>;
	handleSafety(context: CommandExecutionContext): Promise<void>;
	handleGit(context: CommandExecutionContext): Promise<void>;
	handleAuth(context: CommandExecutionContext): Promise<void>;
	handleUsage(context: CommandExecutionContext): Promise<void>;
	handleUndo(context: CommandExecutionContext): Promise<void>;
	handleConfig(context: CommandExecutionContext): Promise<void>;
	handleTools(context: CommandExecutionContext): Promise<void>;
};

export type GroupedCommandDeps = {
	session: {
		handleNewChat: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleClear: () => void | Promise<void>;
		handleSessionInfo: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleSessionsList: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleBranch: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleTree: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleQueue: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleExport: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleShare: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleRecover: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleCleanup: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	diag: {
		handleStatus: () => void | Promise<void>;
		handleAbout: () => void | Promise<void>;
		handleContext: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleStats: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleBackground: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleDiagnostics: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleTelemetry: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleTraining: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleOtel: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleMcp: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleSources: (ctx: CommandExecutionContext) => void | Promise<void>;
		handlePerf: () => void | Promise<void>;
	};
	ui: {
		showTheme: () => void | Promise<void>;
		handleClean: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleFooter: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleZen: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleCompactTools: (ctx: CommandExecutionContext) => void | Promise<void>;
		getUiState: () => {
			zenMode: boolean;
			cleanMode: string;
			footerMode: string;
			compactTools: boolean;
		};
	};
	safety: {
		handleApprovals: (ctx: CommandExecutionContext) => void | Promise<void>;
		handlePlanMode: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleGuardian: (ctx: CommandExecutionContext) => void | Promise<void>;
		getSafetyState: () => {
			approvalMode: string;
			planMode: boolean;
			guardianEnabled: boolean;
		};
	};
	git: {
		handleDiff: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleReview: (ctx: CommandExecutionContext) => void | Promise<void>;
		runGitCommand: (cmd: string) => Promise<string>;
	};
	auth: {
		handleLogin: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleLogout: (ctx: CommandExecutionContext) => void | Promise<void>;
		getAuthState: () => {
			authenticated: boolean;
			provider?: string;
			mode?: string;
		};
	};
	usage: {
		handleCost: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleQuota: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleStats: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	undo: {
		handleUndo: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleCheckpoint: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleChanges: (ctx: CommandExecutionContext) => void | Promise<void>;
		getUndoState: () => {
			canUndo: boolean;
			undoCount: number;
			checkpoints: string[];
		};
	};
	config: {
		handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleImport: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleFramework: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleComposer: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleInit: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	tools: {
		handleTools: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleMcp: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleLsp: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleWorkflow: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleRun: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleCommands: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
};

export function createGroupedCommandHandlers(
	deps: GroupedCommandDeps,
): GroupedCommandHandlers {
	return {
		async handleSession(context: CommandExecutionContext): Promise<void> {
			const { createSessionCommandHandler } = await import(
				"./grouped/index.js"
			);
			const handler = createSessionCommandHandler({
				handleNewChat: () => deps.session.handleNewChat(context),
				handleClear: () => deps.session.handleClear(),
				handleSessionInfo: (ctx: CommandExecutionContext) =>
					deps.session.handleSessionInfo(ctx),
				handleSessionsList: (ctx: CommandExecutionContext) =>
					deps.session.handleSessionsList(ctx),
				handleBranch: (ctx: CommandExecutionContext) =>
					deps.session.handleBranch(ctx),
				handleTree: (ctx: CommandExecutionContext) =>
					deps.session.handleTree(ctx),
				handleQueue: (ctx: CommandExecutionContext) =>
					deps.session.handleQueue(ctx),
				handleExport: (ctx: CommandExecutionContext) =>
					deps.session.handleExport(ctx),
				handleShare: (ctx: CommandExecutionContext) =>
					deps.session.handleShare(ctx),
				handleRecover: (ctx: CommandExecutionContext) =>
					deps.session.handleRecover(ctx),
				handleCleanup: (ctx: CommandExecutionContext) =>
					deps.session.handleCleanup(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
			});
			await handler(context);
		},

		async handleDiag(context: CommandExecutionContext): Promise<void> {
			const { createDiagCommandHandler } = await import("./grouped/index.js");
			const handler = createDiagCommandHandler({
				handleStatus: () => deps.diag.handleStatus(),
				handleAbout: () => deps.diag.handleAbout(),
				handleContext: () => deps.diag.handleContext(context),
				handleStats: (ctx: CommandExecutionContext) =>
					deps.diag.handleStats(ctx),
				handleBackground: (ctx: CommandExecutionContext) =>
					deps.diag.handleBackground(ctx),
				handleDiagnostics: (ctx: CommandExecutionContext) =>
					deps.diag.handleDiagnostics(ctx),
				handleTelemetry: (ctx: CommandExecutionContext) =>
					deps.diag.handleTelemetry(ctx),
				handleTraining: (ctx: CommandExecutionContext) =>
					deps.diag.handleTraining(ctx),
				handleOtel: (ctx: CommandExecutionContext) => deps.diag.handleOtel(ctx),
				handleConfig: (ctx: CommandExecutionContext) =>
					deps.diag.handleConfig(ctx),
				handleLsp: (ctx: CommandExecutionContext) => deps.diag.handleLsp(ctx),
				handleMcp: (ctx: CommandExecutionContext) => deps.diag.handleMcp(ctx),
				handleSources: (ctx: CommandExecutionContext) =>
					deps.diag.handleSources(ctx),
				handlePerf: () => deps.diag.handlePerf(),
				showInfo: (msg: string) => context.showInfo(msg),
				isDatabaseConfigured: () => isDatabaseConfigured(),
			});
			await handler(context);
		},

		async handleUi(context: CommandExecutionContext): Promise<void> {
			const { createUiCommandHandler } = await import("./grouped/index.js");
			const handler = createUiCommandHandler({
				handleTheme: () => deps.ui.showTheme(),
				handleClean: async (ctx: CommandExecutionContext) =>
					deps.ui.handleClean(ctx),
				handleFooter: async (ctx: CommandExecutionContext) =>
					deps.ui.handleFooter(ctx),
				handleZen: async (ctx: CommandExecutionContext) =>
					deps.ui.handleZen(ctx),
				handleCompactTools: async (ctx: CommandExecutionContext) =>
					deps.ui.handleCompactTools(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
				getUiState: () => deps.ui.getUiState(),
			});
			handler(context);
		},

		async handleSafety(context: CommandExecutionContext): Promise<void> {
			const { createSafetyCommandHandler } = await import("./grouped/index.js");
			const handler = createSafetyCommandHandler({
				handleApprovals: async (ctx: CommandExecutionContext) =>
					deps.safety.handleApprovals(ctx),
				handlePlanMode: async (ctx: CommandExecutionContext) =>
					deps.safety.handlePlanMode(ctx),
				handleGuardian: async (ctx: CommandExecutionContext) =>
					deps.safety.handleGuardian(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
				getSafetyState: () => deps.safety.getSafetyState(),
			});
			await handler(context);
		},

		async handleGit(context: CommandExecutionContext): Promise<void> {
			const { createGitCommandHandler } = await import("./grouped/index.js");
			const handler = createGitCommandHandler({
				handleDiff: async (ctx: CommandExecutionContext) =>
					deps.git.handleDiff(ctx),
				handleReview: (ctx: CommandExecutionContext) =>
					deps.git.handleReview(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
				runGitCommand: (cmd: string) => deps.git.runGitCommand(cmd),
			});
			await handler(context);
		},

		async handleAuth(context: CommandExecutionContext): Promise<void> {
			const { createAuthCommandHandler } = await import("./grouped/index.js");
			const handler = createAuthCommandHandler({
				handleLogin: async (ctx: CommandExecutionContext) =>
					deps.auth.handleLogin(ctx),
				handleLogout: async (ctx: CommandExecutionContext) =>
					deps.auth.handleLogout(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
				getAuthState: () => deps.auth.getAuthState(),
			});
			await handler(context);
		},

		async handleUsage(context: CommandExecutionContext): Promise<void> {
			const { createUsageCommandHandler } = await import("./grouped/index.js");
			const handler = createUsageCommandHandler({
				handleCost: async (ctx: CommandExecutionContext) =>
					deps.usage.handleCost(ctx),
				handleQuota: async (ctx: CommandExecutionContext) =>
					deps.usage.handleQuota(ctx),
				handleStats: async (ctx: CommandExecutionContext) =>
					deps.usage.handleStats(ctx),
			});
			await handler(context);
		},

		async handleUndo(context: CommandExecutionContext): Promise<void> {
			const { createUndoCommandHandler } = await import("./grouped/index.js");
			const handler = createUndoCommandHandler({
				handleUndo: async (ctx: CommandExecutionContext) =>
					deps.undo.handleUndo(ctx),
				handleCheckpoint: async (ctx: CommandExecutionContext) =>
					deps.undo.handleCheckpoint(ctx),
				handleChanges: async (ctx: CommandExecutionContext) =>
					deps.undo.handleChanges(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
				getUndoState: () => deps.undo.getUndoState(),
			});
			await handler(context);
		},

		async handleConfig(context: CommandExecutionContext): Promise<void> {
			const { createConfigCommandHandler } = await import("./grouped/index.js");
			const handler = createConfigCommandHandler({
				handleConfig: async (ctx: CommandExecutionContext) =>
					deps.config.handleConfig(ctx),
				handleImport: async (ctx: CommandExecutionContext) =>
					deps.config.handleImport(ctx),
				handleFramework: async (ctx: CommandExecutionContext) =>
					deps.config.handleFramework(ctx),
				handleComposer: async (ctx: CommandExecutionContext) =>
					deps.config.handleComposer(ctx),
				handleInit: async (ctx: CommandExecutionContext) =>
					deps.config.handleInit(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
			});
			await handler(context);
		},

		async handleTools(context: CommandExecutionContext): Promise<void> {
			const { createToolsCommandHandler } = await import("./grouped/index.js");
			const handler = createToolsCommandHandler({
				handleTools: async (ctx: CommandExecutionContext) =>
					deps.tools.handleTools(ctx),
				handleMcp: async (ctx: CommandExecutionContext) =>
					deps.tools.handleMcp(ctx),
				handleLsp: async (ctx: CommandExecutionContext) =>
					deps.tools.handleLsp(ctx),
				handleWorkflow: async (ctx: CommandExecutionContext) =>
					deps.tools.handleWorkflow(ctx),
				handleRun: async (ctx: CommandExecutionContext) =>
					deps.tools.handleRun(ctx),
				handleCommands: async (ctx: CommandExecutionContext) =>
					deps.tools.handleCommands(ctx),
				showInfo: (msg: string) => context.showInfo(msg),
			});
			await handler(context);
		},
	};
}
