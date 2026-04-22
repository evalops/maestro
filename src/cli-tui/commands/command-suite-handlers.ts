import { isDatabaseConfigured } from "../../db/client.js";
import {
	createAuthCommandHandler,
	createConfigCommandHandler,
	createDiagCommandHandler,
	createGitCommandHandler,
	createSafetyCommandHandler,
	createSessionCommandHandler,
	createToolsCommandHandler,
	createUiCommandHandler,
	createUndoCommandHandler,
	createUsageCommandHandler,
} from "./subcommands/index.js";
import type { CommandExecutionContext } from "./types.js";

export type CommandSuiteKey =
	| "session"
	| "diag"
	| "ui"
	| "safety"
	| "git"
	| "auth"
	| "usage"
	| "undo"
	| "config"
	| "tools";

export type CommandSuiteHandlers = Record<
	CommandSuiteKey,
	(context: CommandExecutionContext) => Promise<void>
>;

export type CommandSuiteDeps = {
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
		handleSourceOfTruthPolicy: (
			ctx: CommandExecutionContext,
		) => void | Promise<void>;
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

export function createCommandSuiteHandlers(
	deps: CommandSuiteDeps,
): CommandSuiteHandlers {
	return {
		session: createSessionCommandHandler({
			handleNewChat: (ctx) => deps.session.handleNewChat(ctx),
			handleClear: () => deps.session.handleClear(),
			handleSessionInfo: (ctx) => deps.session.handleSessionInfo(ctx),
			handleSessionsList: (ctx) => deps.session.handleSessionsList(ctx),
			handleBranch: (ctx) => deps.session.handleBranch(ctx),
			handleTree: (ctx) => deps.session.handleTree(ctx),
			handleQueue: (ctx) => deps.session.handleQueue(ctx),
			handleExport: (ctx) => deps.session.handleExport(ctx),
			handleShare: (ctx) => deps.session.handleShare(ctx),
			handleRecover: (ctx) => deps.session.handleRecover(ctx),
			handleCleanup: (ctx) => deps.session.handleCleanup(ctx),
		}),
		diag: createDiagCommandHandler({
			handleStatus: () => deps.diag.handleStatus(),
			handleAbout: () => deps.diag.handleAbout(),
			handleContext: (ctx) => deps.diag.handleContext(ctx),
			handleStats: (ctx) => deps.diag.handleStats(ctx),
			handleBackground: (ctx) => deps.diag.handleBackground(ctx),
			handleDiagnostics: (ctx) => deps.diag.handleDiagnostics(ctx),
			handleTelemetry: (ctx) => deps.diag.handleTelemetry(ctx),
			handleTraining: (ctx) => deps.diag.handleTraining(ctx),
			handleOtel: (ctx) => deps.diag.handleOtel(ctx),
			handleConfig: (ctx) => deps.diag.handleConfig(ctx),
			handleLsp: (ctx) => deps.diag.handleLsp(ctx),
			handleMcp: (ctx) => deps.diag.handleMcp(ctx),
			handleSources: (ctx) => deps.diag.handleSources(ctx),
			handlePerf: () => deps.diag.handlePerf(),
			isDatabaseConfigured: () => isDatabaseConfigured(),
		}),
		ui: createUiCommandHandler({
			handleTheme: () => deps.ui.showTheme(),
			handleClean: (ctx) => deps.ui.handleClean(ctx),
			handleFooter: (ctx) => deps.ui.handleFooter(ctx),
			handleZen: (ctx) => deps.ui.handleZen(ctx),
			handleCompactTools: (ctx) => deps.ui.handleCompactTools(ctx),
			getUiState: () => deps.ui.getUiState(),
		}),
		safety: createSafetyCommandHandler({
			handleApprovals: (ctx) => deps.safety.handleApprovals(ctx),
			handlePlanMode: (ctx) => deps.safety.handlePlanMode(ctx),
			handleGuardian: (ctx) => deps.safety.handleGuardian(ctx),
			getSafetyState: () => deps.safety.getSafetyState(),
		}),
		git: createGitCommandHandler({
			handleDiff: (ctx) => deps.git.handleDiff(ctx),
			handleReview: (ctx) => deps.git.handleReview(ctx),
			runGitCommand: (cmd) => deps.git.runGitCommand(cmd),
		}),
		auth: createAuthCommandHandler({
			handleLogin: (ctx) => deps.auth.handleLogin(ctx),
			handleLogout: (ctx) => deps.auth.handleLogout(ctx),
			handleSourceOfTruthPolicy: (ctx) =>
				deps.auth.handleSourceOfTruthPolicy(ctx),
			getAuthState: () => deps.auth.getAuthState(),
		}),
		usage: createUsageCommandHandler({
			handleCost: (ctx) => deps.usage.handleCost(ctx),
			handleQuota: (ctx) => deps.usage.handleQuota(ctx),
			handleStats: (ctx) => deps.usage.handleStats(ctx),
		}),
		undo: createUndoCommandHandler({
			handleUndo: (ctx) => deps.undo.handleUndo(ctx),
			handleCheckpoint: (ctx) => deps.undo.handleCheckpoint(ctx),
			handleChanges: (ctx) => deps.undo.handleChanges(ctx),
			getUndoState: () => deps.undo.getUndoState(),
		}),
		config: createConfigCommandHandler({
			handleConfig: (ctx) => deps.config.handleConfig(ctx),
			handleImport: (ctx) => deps.config.handleImport(ctx),
			handleFramework: (ctx) => deps.config.handleFramework(ctx),
			handleComposer: (ctx) => deps.config.handleComposer(ctx),
			handleInit: (ctx) => deps.config.handleInit(ctx),
		}),
		tools: createToolsCommandHandler({
			handleTools: (ctx) => deps.tools.handleTools(ctx),
			handleMcp: (ctx) => deps.tools.handleMcp(ctx),
			handleLsp: (ctx) => deps.tools.handleLsp(ctx),
			handleWorkflow: (ctx) => deps.tools.handleWorkflow(ctx),
			handleRun: (ctx) => deps.tools.handleRun(ctx),
			handleCommands: (ctx) => deps.tools.handleCommands(ctx),
		}),
	};
}
