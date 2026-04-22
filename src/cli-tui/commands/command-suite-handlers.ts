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

export enum CommandSuiteKey {
	Session = "session",
	Diag = "diag",
	Ui = "ui",
	Safety = "safety",
	Git = "git",
	Auth = "auth",
	Usage = "usage",
	Undo = "undo",
	Config = "config",
	Tools = "tools",
}

export type CommandSuiteHandlers = Record<
	CommandSuiteKey,
	(context: CommandExecutionContext) => Promise<void>
>;

export type CommandSuiteDeps = {
	[CommandSuiteKey.Session]: {
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
	[CommandSuiteKey.Diag]: {
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
	[CommandSuiteKey.Ui]: {
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
	[CommandSuiteKey.Safety]: {
		handleApprovals: (ctx: CommandExecutionContext) => void | Promise<void>;
		handlePlanMode: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleGuardian: (ctx: CommandExecutionContext) => void | Promise<void>;
		getSafetyState: () => {
			approvalMode: string;
			planMode: boolean;
			guardianEnabled: boolean;
		};
	};
	[CommandSuiteKey.Git]: {
		handleDiff: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleReview: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	[CommandSuiteKey.Auth]: {
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
	[CommandSuiteKey.Usage]: {
		handleCost: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleQuota: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleStats: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	[CommandSuiteKey.Undo]: {
		handleUndo: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleCheckpoint: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleChanges: (ctx: CommandExecutionContext) => void | Promise<void>;
		getUndoState: () => {
			canUndo: boolean;
			undoCount: number;
			checkpoints: string[];
		};
	};
	[CommandSuiteKey.Config]: {
		handleConfig: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleImport: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleFramework: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleComposer: (ctx: CommandExecutionContext) => void | Promise<void>;
		handleInit: (ctx: CommandExecutionContext) => void | Promise<void>;
	};
	[CommandSuiteKey.Tools]: {
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
	const session = deps[CommandSuiteKey.Session];
	const diag = deps[CommandSuiteKey.Diag];
	const ui = deps[CommandSuiteKey.Ui];
	const safety = deps[CommandSuiteKey.Safety];
	const git = deps[CommandSuiteKey.Git];
	const auth = deps[CommandSuiteKey.Auth];
	const usage = deps[CommandSuiteKey.Usage];
	const undo = deps[CommandSuiteKey.Undo];
	const config = deps[CommandSuiteKey.Config];
	const tools = deps[CommandSuiteKey.Tools];

	return {
		[CommandSuiteKey.Session]: createSessionCommandHandler({
			handleNewChat: (ctx) => session.handleNewChat(ctx),
			handleClear: () => session.handleClear(),
			handleSessionInfo: (ctx) => session.handleSessionInfo(ctx),
			handleSessionsList: (ctx) => session.handleSessionsList(ctx),
			handleBranch: (ctx) => session.handleBranch(ctx),
			handleTree: (ctx) => session.handleTree(ctx),
			handleQueue: (ctx) => session.handleQueue(ctx),
			handleExport: (ctx) => session.handleExport(ctx),
			handleShare: (ctx) => session.handleShare(ctx),
			handleRecover: (ctx) => session.handleRecover(ctx),
			handleCleanup: (ctx) => session.handleCleanup(ctx),
		}),
		[CommandSuiteKey.Diag]: createDiagCommandHandler({
			handleStatus: () => diag.handleStatus(),
			handleAbout: () => diag.handleAbout(),
			handleContext: (ctx) => diag.handleContext(ctx),
			handleStats: (ctx) => diag.handleStats(ctx),
			handleBackground: (ctx) => diag.handleBackground(ctx),
			handleDiagnostics: (ctx) => diag.handleDiagnostics(ctx),
			handleTelemetry: (ctx) => diag.handleTelemetry(ctx),
			handleTraining: (ctx) => diag.handleTraining(ctx),
			handleOtel: (ctx) => diag.handleOtel(ctx),
			handleConfig: (ctx) => diag.handleConfig(ctx),
			handleLsp: (ctx) => diag.handleLsp(ctx),
			handleMcp: (ctx) => diag.handleMcp(ctx),
			handleSources: (ctx) => diag.handleSources(ctx),
			handlePerf: () => diag.handlePerf(),
			isDatabaseConfigured: () => isDatabaseConfigured(),
		}),
		[CommandSuiteKey.Ui]: createUiCommandHandler({
			handleTheme: () => ui.showTheme(),
			handleClean: (ctx) => ui.handleClean(ctx),
			handleFooter: (ctx) => ui.handleFooter(ctx),
			handleZen: (ctx) => ui.handleZen(ctx),
			handleCompactTools: (ctx) => ui.handleCompactTools(ctx),
			getUiState: () => ui.getUiState(),
		}),
		[CommandSuiteKey.Safety]: createSafetyCommandHandler({
			handleApprovals: (ctx) => safety.handleApprovals(ctx),
			handlePlanMode: (ctx) => safety.handlePlanMode(ctx),
			handleGuardian: (ctx) => safety.handleGuardian(ctx),
			getSafetyState: () => safety.getSafetyState(),
		}),
		[CommandSuiteKey.Git]: createGitCommandHandler({
			handleDiff: (ctx) => git.handleDiff(ctx),
			handleReview: (ctx) => git.handleReview(ctx),
		}),
		[CommandSuiteKey.Auth]: createAuthCommandHandler({
			handleLogin: (ctx) => auth.handleLogin(ctx),
			handleLogout: (ctx) => auth.handleLogout(ctx),
			handleSourceOfTruthPolicy: (ctx) => auth.handleSourceOfTruthPolicy(ctx),
			getAuthState: () => auth.getAuthState(),
		}),
		[CommandSuiteKey.Usage]: createUsageCommandHandler({
			handleCost: (ctx) => usage.handleCost(ctx),
			handleQuota: (ctx) => usage.handleQuota(ctx),
			handleStats: (ctx) => usage.handleStats(ctx),
		}),
		[CommandSuiteKey.Undo]: createUndoCommandHandler({
			handleUndo: (ctx) => undo.handleUndo(ctx),
			handleCheckpoint: (ctx) => undo.handleCheckpoint(ctx),
			handleChanges: (ctx) => undo.handleChanges(ctx),
			getUndoState: () => undo.getUndoState(),
		}),
		[CommandSuiteKey.Config]: createConfigCommandHandler({
			handleConfig: (ctx) => config.handleConfig(ctx),
			handleImport: (ctx) => config.handleImport(ctx),
			handleFramework: (ctx) => config.handleFramework(ctx),
			handleComposer: (ctx) => config.handleComposer(ctx),
			handleInit: (ctx) => config.handleInit(ctx),
		}),
		[CommandSuiteKey.Tools]: createToolsCommandHandler({
			handleTools: (ctx) => tools.handleTools(ctx),
			handleMcp: (ctx) => tools.handleMcp(ctx),
			handleLsp: (ctx) => tools.handleLsp(ctx),
			handleWorkflow: (ctx) => tools.handleWorkflow(ctx),
			handleRun: (ctx) => tools.handleRun(ctx),
			handleCommands: (ctx) => tools.handleCommands(ctx),
		}),
	};
}
