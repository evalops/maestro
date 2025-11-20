import type { SlashCommand } from "@evalops/tui";
import { createCommandRegistry } from "../../commands/registry.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	RunScriptCompletionProvider,
} from "../../commands/types.js";

interface CommandRegistryOptions {
	getRunScriptCompletions: RunScriptCompletionProvider;
	createContext: (input: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}) => CommandExecutionContext;
	showThinkingSelector: (context: CommandExecutionContext) => void;
	showModelSelector: (context: CommandExecutionContext) => void;
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
	showStatus: (context: CommandExecutionContext) => void;
	handleReview: (context: CommandExecutionContext) => void;
	handleUndo: (context: CommandExecutionContext) => void | Promise<void>;
	handleReport: (context: CommandExecutionContext) => void;
	handleMention: (context: CommandExecutionContext) => void | Promise<void>;
	showHelp: (context: CommandExecutionContext) => void;
	handleUpdate: (context: CommandExecutionContext) => void | Promise<void>;
	handleConfig: (context: CommandExecutionContext) => void | Promise<void>;
	handleCost: (context: CommandExecutionContext) => void | Promise<void>;
	handleTelemetry: (context: CommandExecutionContext) => void;
	handleStats: (context: CommandExecutionContext) => void | Promise<void>;
	handlePlan: (context: CommandExecutionContext) => void | Promise<void>;
	handlePreview: (context: CommandExecutionContext) => void | Promise<void>;
	handleRun: (context: CommandExecutionContext) => void | Promise<void>;
	handleOllama: (context: CommandExecutionContext) => void | Promise<void>;
	handleDiagnostics: (context: CommandExecutionContext) => void | Promise<void>;
	handleCompact: (context: CommandExecutionContext) => void | Promise<void>;
	handleCompactTools: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleQueue: (context: CommandExecutionContext) => void | Promise<void>;
	handleQuit: (context: CommandExecutionContext) => void;
	handleApprovals: (context: CommandExecutionContext) => void;
	handleNewChat: (context: CommandExecutionContext) => void;
	handleInitAgents: (context: CommandExecutionContext) => void;
	handleMcp: (context: CommandExecutionContext) => void;
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
			exportSession: opts.handleExportSession,
			shareSession: opts.handleShareSession,
			tools: opts.handleTools,
			importConfig: opts.handleImportConfig,
			session: opts.handleSession,
			sessions: opts.handleSessions,
			report: opts.handleReport,
			about: opts.handleAbout,
			status: opts.showStatus,
			review: opts.handleReview,
			undoChanges: opts.handleUndo,
			mention: opts.handleMention,
			help: opts.showHelp,
			update: opts.handleUpdate,
			config: opts.handleConfig,
			cost: opts.handleCost,
			telemetry: opts.handleTelemetry,
			stats: opts.handleStats,
			plan: opts.handlePlan,
			preview: opts.handlePreview,
			run: opts.handleRun,
			ollama: opts.handleOllama,
			diagnostics: opts.handleDiagnostics,
			compact: opts.handleCompact,
			compactTools: opts.handleCompactTools,
			queue: opts.handleQueue,
			quit: opts.handleQuit,
			approvals: opts.handleApprovals,
			newChat: opts.handleNewChat,
			initAgents: opts.handleInitAgents,
			mcp: opts.handleMcp,
		},
		createContext: opts.createContext,
	});
	return {
		entries: registry,
		commands: registry.map((entry) => entry.command),
	};
}
