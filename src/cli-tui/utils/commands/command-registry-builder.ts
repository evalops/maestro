import type { SlashCommand } from "@evalops/tui";
import { createCommandRegistry } from "../../commands/registry.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	RunScriptCompletionProvider,
} from "../../commands/types.js";

export interface CommandRegistryOptions {
	getRunScriptCompletions: RunScriptCompletionProvider;
	createContext: (input: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}) => CommandExecutionContext;
	showThinkingSelector: (context: CommandExecutionContext) => void;
	showModelSelector: (context: CommandExecutionContext) => void;
	showThemeSelector: (context: CommandExecutionContext) => void;
	handleExportSession: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleShareSession: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleTools: (context: CommandExecutionContext) => void | Promise<void>;
	handleImportConfig: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleSession: (context: CommandExecutionContext) => void;
	handleSessions: (context: CommandExecutionContext) => void | Promise<void>;
	handleAbout: (context: CommandExecutionContext) => void;
	handleClear: (context: CommandExecutionContext) => Promise<void> | void;
	showStatus: (context: CommandExecutionContext) => void;
	handleReview: (context: CommandExecutionContext) => void;
	handleUndo: (context: CommandExecutionContext) => void | Promise<void>;
	handleReport: (context: CommandExecutionContext) => void;
	handleMention: (context: CommandExecutionContext) => void | Promise<void>;
	handleAccess: (context: CommandExecutionContext) => void;
	showHelp: (context: CommandExecutionContext) => void;
	handleUpdate: (context: CommandExecutionContext) => void | Promise<void>;
	handleChangelog: (context: CommandExecutionContext) => void;
	handleHotkeys: (context: CommandExecutionContext) => void;
	handleConfig: (context: CommandExecutionContext) => void | Promise<void>;
	handleCost: (context: CommandExecutionContext) => void | Promise<void>;
	handleQuota: (context: CommandExecutionContext) => void | Promise<void>;
	handleTelemetry: (context: CommandExecutionContext) => void;
	handleOtel: (context: CommandExecutionContext) => void;
	handleTraining: (context: CommandExecutionContext) => void;
	handleStats: (context: CommandExecutionContext) => void | Promise<void>;
	handlePlan: (context: CommandExecutionContext) => void | Promise<void>;
	handlePreview: (context: CommandExecutionContext) => void | Promise<void>;
	handleRun: (context: CommandExecutionContext) => void | Promise<void>;
	handleOllama: (context: CommandExecutionContext) => void | Promise<void>;
	handleDiagnostics: (context: CommandExecutionContext) => void | Promise<void>;
	handleBackground: (context: CommandExecutionContext) => void;
	handleCompact: (context: CommandExecutionContext) => void | Promise<void>;
	handleAutocompact: (context: CommandExecutionContext) => void;
	handleFooter: (context: CommandExecutionContext) => void | Promise<void>;
	handleCompactTools: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleQueue: (context: CommandExecutionContext) => void | Promise<void>;
	handleBranch: (context: CommandExecutionContext) => void | Promise<void>;
	handleTree: (context: CommandExecutionContext) => void | Promise<void>;
	handleCommands: (context: CommandExecutionContext) => void | Promise<void>;
	handleQuit: (context: CommandExecutionContext) => void;
	handleApprovals: (context: CommandExecutionContext) => void;
	handlePlanMode: (context: CommandExecutionContext) => void;
	handleNewChat: (context: CommandExecutionContext) => void;
	handleInitAgents: (context: CommandExecutionContext) => void;
	handleMcp: (context: CommandExecutionContext) => void;
	handleComposer: (context: CommandExecutionContext) => void;
	handleLogin: (context: CommandExecutionContext) => void | Promise<void>;
	handleLogout: (context: CommandExecutionContext) => void | Promise<void>;
	handleZen: (context: CommandExecutionContext) => void;
	handleContext: (context: CommandExecutionContext) => void;
	handleLsp: (context: CommandExecutionContext) => void | Promise<void>;
	handleFramework: (context: CommandExecutionContext) => void;
	handleClean: (context: CommandExecutionContext) => void;
	handleGuardian: (context: CommandExecutionContext) => void | Promise<void>;
	handleWorkflow: (context: CommandExecutionContext) => void | Promise<void>;
	handleChanges: (context: CommandExecutionContext) => void;
	handleCheckpoint: (context: CommandExecutionContext) => void;
	handleMemory: (context: CommandExecutionContext) => void;
	handleMode: (context: CommandExecutionContext) => void;
	handlePrompts: (context: CommandExecutionContext) => void;
	handleCopy: (context: CommandExecutionContext) => void;
	// Grouped command handlers
	handleSessionCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleDiagCommand: (context: CommandExecutionContext) => void | Promise<void>;
	handleUiCommand: (context: CommandExecutionContext) => void;
	handleSafetyCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleGitCommand: (context: CommandExecutionContext) => void | Promise<void>;
	handleAuthCommand: (context: CommandExecutionContext) => void | Promise<void>;
	handleUsageCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleUndoCommand: (context: CommandExecutionContext) => void | Promise<void>;
	handleConfigCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleToolsCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
}

export function buildCommandRegistry(opts: CommandRegistryOptions): {
	entries: CommandEntry[];
	commands: SlashCommand[];
} {
	const registry = createCommandRegistry({
		getRunScriptCompletions: opts.getRunScriptCompletions,
		handlers: {
			thinking: opts.showThinkingSelector,
			model: opts.showModelSelector,
			theme: opts.showThemeSelector,
			exportSession: opts.handleExportSession,
			shareSession: opts.handleShareSession,
			tools: opts.handleTools,
			importConfig: opts.handleImportConfig,
			session: opts.handleSession,
			sessions: opts.handleSessions,
			report: opts.handleReport,
			about: opts.handleAbout,
			clear: opts.handleClear,
			status: opts.showStatus,
			review: opts.handleReview,
			undoChanges: opts.handleUndo,
			mention: opts.handleMention,
			access: opts.handleAccess,
			help: opts.showHelp,
			update: opts.handleUpdate,
			changelog: opts.handleChangelog,
			hotkeys: opts.handleHotkeys,
			config: opts.handleConfig,
			cost: opts.handleCost,
			quota: opts.handleQuota,
			telemetry: opts.handleTelemetry,
			otel: opts.handleOtel,
			training: opts.handleTraining,
			stats: opts.handleStats,
			plan: opts.handlePlan,
			preview: opts.handlePreview,
			run: opts.handleRun,
			ollama: opts.handleOllama,
			diagnostics: opts.handleDiagnostics,
			background: opts.handleBackground,
			compact: opts.handleCompact,
			autocompact: opts.handleAutocompact,
			footer: opts.handleFooter,
			compactTools: opts.handleCompactTools,
			commands: opts.handleCommands,
			queue: opts.handleQueue,
			branch: opts.handleBranch,
			tree: opts.handleTree,
			quit: opts.handleQuit,
			approvals: opts.handleApprovals,
			newChat: opts.handleNewChat,
			initAgents: opts.handleInitAgents,
			mcp: opts.handleMcp,
			composer: opts.handleComposer,
			login: opts.handleLogin,
			logout: opts.handleLogout,
			planMode: opts.handlePlanMode,
			zen: opts.handleZen,
			context: opts.handleContext,
			lsp: opts.handleLsp,
			framework: opts.handleFramework,
			clean: opts.handleClean,
			guardian: opts.handleGuardian,
			workflow: opts.handleWorkflow,
			changes: opts.handleChanges,
			checkpoint: opts.handleCheckpoint,
			memory: opts.handleMemory,
			mode: opts.handleMode,
			prompts: opts.handlePrompts,
			copy: opts.handleCopy,
			// Grouped command handlers
			sessionCommand: opts.handleSessionCommand,
			diagCommand: opts.handleDiagCommand,
			uiCommand: opts.handleUiCommand,
			safetyCommand: opts.handleSafetyCommand,
			gitCommand: opts.handleGitCommand,
			authCommand: opts.handleAuthCommand,
			usageCommand: opts.handleUsageCommand,
			undoCommand: opts.handleUndoCommand,
			configCommand: opts.handleConfigCommand,
			toolsCommand: opts.handleToolsCommand,
		},
		createContext: opts.createContext,
	});
	return {
		entries: registry,
		commands: registry.map((entry) => entry.command),
	};
}
