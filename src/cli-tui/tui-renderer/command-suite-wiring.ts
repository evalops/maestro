/**
 * CommandSuiteWiring adapts top-level command handlers into parent command
 * suites such as /ss, /diag, /cfg, and /tools.
 */

import {
	type CommandSuiteHandlers,
	CommandSuiteKey,
	createCommandSuiteHandlers,
} from "../commands/command-suite-handlers.js";
import type {
	CommandExecutionContext,
	CommandHandlers,
} from "../commands/types.js";

type SuiteHandlerKey =
	| "about"
	| "approvals"
	| "background"
	| "branch"
	| "changes"
	| "checkpoint"
	| "clean"
	| "clear"
	| "commands"
	| "compactTools"
	| "composer"
	| "config"
	| "context"
	| "cost"
	| "diagnostics"
	| "exportSession"
	| "footer"
	| "framework"
	| "guardian"
	| "importConfig"
	| "initAgents"
	| "login"
	| "logout"
	| "lsp"
	| "mcp"
	| "newChat"
	| "otel"
	| "planMode"
	| "preview"
	| "quota"
	| "queue"
	| "review"
	| "run"
	| "session"
	| "sessions"
	| "shareSession"
	| "stats"
	| "status"
	| "telemetry"
	| "theme"
	| "training"
	| "tree"
	| "tools"
	| "undoChanges"
	| "workflow"
	| "zen";

export type CommandSuiteBaseHandlers = Pick<CommandHandlers, SuiteHandlerKey>;

export interface CommandSuiteRuntimeDeps {
	getUiState: () => {
		zenMode: boolean;
		cleanMode: string;
		footerMode: string;
		compactTools: boolean;
	};
	getAuthState: () => {
		authenticated: boolean;
		provider?: string;
		mode?: string;
	};
	handleSessionRecoverCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	handleSessionCleanupCommand: (
		ctx: CommandExecutionContext,
	) => void | Promise<void>;
	handleSourcesCommand: (ctx: CommandExecutionContext) => void | Promise<void>;
	handlePerfCommand: () => void | Promise<void>;
	handleAuthSourceOfTruthCommand: (
		argumentText: string,
		showError: (msg: string) => void,
		showInfo: (msg: string) => void,
	) => void | Promise<void>;
}

export interface CommandSuiteWiringDeps extends CommandSuiteRuntimeDeps {
	handlers: CommandSuiteBaseHandlers;
}

export function buildCommandSuiteHandlers(
	deps: CommandSuiteWiringDeps,
): CommandSuiteHandlers {
	const { handlers } = deps;

	return createCommandSuiteHandlers({
		[CommandSuiteKey.Session]: {
			handleNewChat: (ctx) => handlers.newChat(ctx),
			handleClear: () => handlers.clear(commandContext("/clear")),
			handleSessionInfo: (ctx) => handlers.session(ctx),
			handleSessionsList: (ctx) => handlers.sessions(ctx),
			handleBranch: (ctx) => handlers.branch(ctx),
			handleTree: (ctx) => handlers.tree(ctx),
			handleQueue: (ctx) => handlers.queue(ctx),
			handleExport: (ctx) => handlers.exportSession(ctx),
			handleShare: (ctx) => handlers.shareSession(ctx),
			handleRecover: (ctx) => deps.handleSessionRecoverCommand(ctx),
			handleCleanup: (ctx) => deps.handleSessionCleanupCommand(ctx),
		},
		[CommandSuiteKey.Diag]: {
			handleStatus: () => handlers.status(commandContext("/status")),
			handleAbout: () => handlers.about(commandContext("/about")),
			handleContext: (ctx) => handlers.context(ctx),
			handleStats: (ctx) => handlers.stats(ctx),
			handleBackground: (ctx) => handlers.background(ctx),
			handleDiagnostics: (ctx) => handlers.diagnostics(ctx),
			handleTelemetry: (ctx) => handlers.telemetry(ctx),
			handleTraining: (ctx) => handlers.training(ctx),
			handleOtel: (ctx) => handlers.otel(ctx),
			handleConfig: (ctx) => handlers.config(ctx),
			handleLsp: (ctx) => handlers.lsp(ctx),
			handleMcp: (ctx) => handlers.mcp(ctx),
			handleSources: (ctx) => deps.handleSourcesCommand(ctx),
			handlePerf: () => deps.handlePerfCommand(),
		},
		[CommandSuiteKey.Ui]: {
			showTheme: () => handlers.theme(commandContext("/theme")),
			handleClean: (ctx) => handlers.clean(ctx),
			handleFooter: (ctx) => handlers.footer(ctx),
			handleZen: (ctx) => handlers.zen(ctx),
			handleCompactTools: (ctx) => handlers.compactTools(ctx),
			getUiState: () => deps.getUiState(),
		},
		[CommandSuiteKey.Safety]: {
			handleApprovals: (ctx) => handlers.approvals(ctx),
			handlePlanMode: (ctx) => handlers.planMode(ctx),
			handleGuardian: (ctx) => handlers.guardian(ctx),
			getSafetyState: () => ({
				approvalMode: process.env.MAESTRO_APPROVALS ?? "prompt",
				planMode: process.env.MAESTRO_PLAN_MODE === "1",
				guardianEnabled: true,
			}),
		},
		[CommandSuiteKey.Git]: {
			handleDiff: (ctx) => handlers.preview(ctx),
			handleReview: (ctx) => handlers.review(ctx),
		},
		[CommandSuiteKey.Auth]: {
			handleLogin: (ctx) => handlers.login(ctx),
			handleLogout: (ctx) => handlers.logout(ctx),
			handleSourceOfTruthPolicy: (ctx) =>
				deps.handleAuthSourceOfTruthCommand(
					ctx.argumentText,
					(msg) => ctx.showError(msg),
					(msg) => ctx.showInfo(msg),
				),
			getAuthState: () => deps.getAuthState(),
		},
		[CommandSuiteKey.Usage]: {
			handleCost: (ctx) => handlers.cost(ctx),
			handleQuota: (ctx) => handlers.quota(ctx),
			handleStats: (ctx) => handlers.stats(ctx),
		},
		[CommandSuiteKey.Undo]: {
			handleUndo: (ctx) => handlers.undoChanges(ctx),
			handleCheckpoint: (ctx) => handlers.checkpoint(ctx),
			handleChanges: (ctx) => handlers.changes(ctx),
			getUndoState: () => ({
				canUndo: true,
				undoCount: 0,
				checkpoints: [],
			}),
		},
		[CommandSuiteKey.Config]: {
			handleConfig: (ctx) => handlers.config(ctx),
			handleImport: (ctx) => handlers.importConfig(ctx),
			handleFramework: (ctx) => handlers.framework(ctx),
			handleComposer: (ctx) => handlers.composer(ctx),
			handleInit: (ctx) => handlers.initAgents(ctx),
		},
		[CommandSuiteKey.Tools]: {
			handleTools: (ctx) => handlers.tools(ctx),
			handleMcp: (ctx) => handlers.mcp(ctx),
			handleLsp: (ctx) => handlers.lsp(ctx),
			handleWorkflow: (ctx) => handlers.workflow(ctx),
			handleRun: (ctx) => handlers.run(ctx),
			handleCommands: (ctx) => handlers.commands(ctx),
		},
	});
}

function commandContext(rawInput: string): CommandExecutionContext {
	return {
		command: { name: rawInput.replace(/^\//, ""), description: "" },
		rawInput,
		argumentText: "",
		showInfo: () => undefined,
		showError: () => undefined,
		renderHelp: () => undefined,
	};
}
