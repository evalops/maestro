import type { SlashCommand } from "../tui-lib/index.js";
import { createCommandRegistry } from "./commands/registry.js";
import type {
	CommandEntry,
	CommandExecutionContext,
	RunScriptCompletionProvider,
} from "./commands/types.js";

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
	handleTools: (context: CommandExecutionContext) => void | Promise<void>;
	handleImportConfig: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	showSessionInfo: (context: CommandExecutionContext) => void;
	handleSessions: (context: CommandExecutionContext) => void | Promise<void>;
	handleBug: (context: CommandExecutionContext) => void;
	showStatus: (context: CommandExecutionContext) => void;
	handleReview: (context: CommandExecutionContext) => void;
	handleUndo: (context: CommandExecutionContext) => void | Promise<void>;
	shareFeedback: (context: CommandExecutionContext) => void;
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
	handleWhy: (context: CommandExecutionContext) => void;
	handleDiagnostics: (context: CommandExecutionContext) => void | Promise<void>;
	handleCompact: (context: CommandExecutionContext) => void | Promise<void>;
	handleCompactTools: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleQuit: (context: CommandExecutionContext) => void;
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
			tools: opts.handleTools,
			importConfig: opts.handleImportConfig,
			sessionInfo: opts.showSessionInfo,
			sessions: opts.handleSessions,
			reportBug: opts.handleBug,
			status: opts.showStatus,
			review: opts.handleReview,
			undoChanges: opts.handleUndo,
			shareFeedback: opts.shareFeedback,
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
			why: opts.handleWhy,
			diagnostics: opts.handleDiagnostics,
			compact: opts.handleCompact,
			compactTools: opts.handleCompactTools,
			quit: opts.handleQuit,
		},
		createContext: opts.createContext,
	});
	return {
		entries: registry,
		commands: registry.map((entry) => entry.command),
	};
}
