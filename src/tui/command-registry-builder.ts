import type { SlashCommand } from "../tui-lib/index.js";
import { createCommandRegistry } from "./commands/registry.js";
import type {
	CommandEntry,
	RunScriptCompletionProvider,
} from "./commands/types.js";

interface CommandRegistryOptions {
	getRunScriptCompletions: RunScriptCompletionProvider;
	showThinkingSelector: () => void;
	showModelSelector: () => void;
	handleExportSession: (input: string) => void;
	handleTools: (input: string) => void;
	handleImportConfig: (input: string) => void;
	showSessionInfo: () => void;
	handleSessions: (input: string) => void;
	handleBug: () => void;
	showStatus: () => void;
	handleReview: () => void;
	handleUndo: (input: string) => void;
	shareFeedback: () => void;
	handleMention: (input: string) => void;
	showHelp: () => void;
	handleUpdate: () => void | Promise<void>;
	handlePlan: (input: string) => void;
	handlePreview: (input: string) => void;
	handleRun: (input: string) => void;
	handleWhy: () => void;
	handleDiagnostics: (input: string) => void;
	handleCompact: () => void;
	handleCompactTools: (input: string) => void;
	handleQuit: () => void;
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
			plan: opts.handlePlan,
			preview: opts.handlePreview,
			run: opts.handleRun,
			why: opts.handleWhy,
			diagnostics: opts.handleDiagnostics,
			compact: opts.handleCompact,
			compactTools: opts.handleCompactTools,
			quit: opts.handleQuit,
		},
	});
	return {
		entries: registry,
		commands: registry.map((entry) => entry.command),
	};
}
