import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../../src/cli-tui/commands/types.js";
import {
	type TuiCommandRegistryDeps,
	buildTuiCommandRegistryOptions,
} from "../../src/cli-tui/tui-renderer/command-registry-options.js";

function createCommandContext(
	rawInput: string,
	argumentText = "",
	parsedArgs?: Record<string, unknown>,
): CommandExecutionContext {
	return {
		command: { name: "test", description: "test" },
		rawInput,
		argumentText,
		parsedArgs,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

function createDeps() {
	const aboutView = { handleAboutCommand: vi.fn() };
	const configView = { handleConfigCommand: vi.fn() };
	const costView = { handleCostCommand: vi.fn() };
	const feedbackView = {
		handleBugCommand: vi.fn(),
		handleFeedbackCommand: vi.fn(),
	};
	const fileSearchView = { handleMentionCommand: vi.fn() };
	const importExportView = {
		handleExportCommand: vi.fn(),
		handleImportCommand: vi.fn(),
		handleShareCommand: vi.fn(),
	};
	const queuePanelController = { handleQueueCommand: vi.fn() };
	const reportSelectorView = { show: vi.fn() };
	const runCommandView = {
		getRunScriptCompletions: vi.fn(() => null),
		handleRunCommand: vi.fn(),
	};
	const toolStatusView = { handleToolsCommand: vi.fn() };
	const diagnosticsView = {
		handleStatusCommand: vi.fn(),
		handleDiagnosticsCommand: vi.fn(),
	};
	const thinkingSelectorView = { show: vi.fn() };
	const clearController = { handleClearCommand: vi.fn() };
	const customCommandsController = {
		handleCommandsCommand: vi.fn(),
		handlePromptsCommand: vi.fn(),
	};
	const branchController = { handleBranchCommand: vi.fn() };

	const deps = {
		getRunCommandView: vi.fn(() => runCommandView),
		getToolStatusView: vi.fn(() => toolStatusView),
		sessionView: {
			handleSessionCommand: vi.fn(),
			handleSessionsCommand: vi.fn(),
		},
		getClearController: vi.fn(() => clearController),
		getDiagnosticsView: vi.fn(() => diagnosticsView),
		gitView: { handlePreviewCommand: vi.fn() },
		backgroundTasksController: { handleBackgroundCommand: vi.fn() },
		compactionController: {
			handleCompactCommand: vi.fn(),
			handleAutocompactCommand: vi.fn(),
		},
		getCustomCommandsController: vi.fn(() => customCommandsController),
		getBranchController: vi.fn(() => branchController),
		oauthFlowController: {
			handleLoginCommand: vi.fn(),
			handleLogoutCommand: vi.fn(),
		},
		approvalService: {} as TuiCommandRegistryDeps["approvalService"],
		notificationView: {
			showInfo: vi.fn(),
			showToast: vi.fn(),
		} as unknown as TuiCommandRegistryDeps["notificationView"],
		chatContainer: {
			addChild: vi.fn(),
		} as unknown as TuiCommandRegistryDeps["chatContainer"],
		ui: { requestRender: vi.fn() } as unknown as TuiCommandRegistryDeps["ui"],
		uiStateController: {
			handleZenCommand: vi.fn(),
			handleCleanCommand: vi.fn(),
		},
		getImportExportView: vi.fn(() => importExportView),
		getReportSelectorView: vi.fn(() => reportSelectorView),
		getFeedbackView: vi.fn(() => feedbackView),
		getAboutView: vi.fn(() => aboutView),
		getInfoView: vi.fn(() => ({ showHelp: vi.fn() })),
		getUpdateView: vi.fn(() => ({ handleUpdateCommand: vi.fn() })),
		getChangelogView: vi.fn(() => ({ handleChangelogCommand: vi.fn() })),
		getHotkeysView: vi.fn(() => ({ handleHotkeysCommand: vi.fn() })),
		getConfigView: vi.fn(() => configView),
		getCostView: vi.fn(() => costView),
		getQuotaView: vi.fn(() => ({ handleQuotaCommand: vi.fn() })),
		getTelemetryView: vi.fn(() => ({ handleTelemetryCommand: vi.fn() })),
		getTrainingView: vi.fn(() => ({ handleTrainingCommand: vi.fn() })),
		getOllamaView: vi.fn(() => ({ handleOllamaCommand: vi.fn() })),
		getThinkingSelectorView: vi.fn(() => thinkingSelectorView),
		getModelSelectorView: vi.fn(() => ({ show: vi.fn() })),
		getThemeSelectorView: vi.fn(() => ({ show: vi.fn() })),
		getLspView: vi.fn(() => ({ handleLspCommand: vi.fn() })),
		getFileSearchView: vi.fn(() => fileSearchView),
		getQueuePanelController: vi.fn(() => queuePanelController),
		getMessages: vi.fn(() => []),
		createCommandContext: vi.fn(
			(input: {
				command: SlashCommand;
				rawInput: string;
				argumentText: string;
				parsedArgs?: Record<string, unknown>;
			}) =>
				createCommandContext(
					input.rawInput,
					input.argumentText,
					input.parsedArgs,
				),
		),
		handleReviewCommand: vi.fn(),
		handleHistoryCommand: vi.fn(),
		handleToolHistoryCommand: vi.fn(),
		handleSkillsCommand: vi.fn(),
		handleEnhancedUndoCommand: vi.fn(),
		handleFooterCommand: vi.fn(),
		handleCompactToolsCommand: vi.fn(),
		handleSteerCommand: vi.fn(),
		handleStatsCommand: vi.fn(),
		handleNewChatCommand: vi.fn(),
		handleTreeCommand: vi.fn(),
		handleMcpCommand: vi.fn(),
		handleComposerCommand: vi.fn(),
		handleContextCommand: vi.fn(),
		handleFrameworkCommand: vi.fn(),
		handleGuardianCommand: vi.fn(),
		handleWorkflowCommand: vi.fn(),
		handleChangesCommand: vi.fn(),
		handleCheckpointCommand: vi.fn(),
		handleMemoryCommand: vi.fn(),
		handleModeCommand: vi.fn(),
		getGroupedHandlers: vi.fn(
			() =>
				({
					session: vi.fn(),
					diag: vi.fn(),
					ui: vi.fn(),
					safety: vi.fn(),
					git: vi.fn(),
					auth: vi.fn(),
					usage: vi.fn(),
					undo: vi.fn(),
					config: vi.fn(),
					tools: vi.fn(),
				}) as TuiCommandRegistryDeps["getGroupedHandlers"] extends () => infer T
					? T
					: never,
		),
		refreshFooterHint: vi.fn(),
		onQuit: vi.fn(),
	} as unknown as TuiCommandRegistryDeps;

	return {
		deps,
		aboutView,
		configView,
		costView,
		feedbackView,
		fileSearchView,
		importExportView,
		queuePanelController,
		reportSelectorView,
		runCommandView,
		toolStatusView,
		diagnosticsView,
		thinkingSelectorView,
		clearController,
		customCommandsController,
		branchController,
	};
}

describe("buildTuiCommandRegistryOptions", () => {
	it("does not resolve lazy command views while building the registry", () => {
		const { deps } = createDeps();

		buildTuiCommandRegistryOptions(deps);

		expect(deps.getAboutView).not.toHaveBeenCalled();
		expect(deps.getConfigView).not.toHaveBeenCalled();
		expect(deps.getCostView).not.toHaveBeenCalled();
		expect(deps.getImportExportView).not.toHaveBeenCalled();
		expect(deps.getReportSelectorView).not.toHaveBeenCalled();
		expect(deps.getToolStatusView).not.toHaveBeenCalled();
		expect(deps.getDiagnosticsView).not.toHaveBeenCalled();
		expect(deps.getRunCommandView).not.toHaveBeenCalled();
		expect(deps.getThinkingSelectorView).not.toHaveBeenCalled();
		expect(deps.getFileSearchView).not.toHaveBeenCalled();
		expect(deps.getQueuePanelController).not.toHaveBeenCalled();
		expect(deps.getClearController).not.toHaveBeenCalled();
		expect(deps.getCustomCommandsController).not.toHaveBeenCalled();
		expect(deps.getBranchController).not.toHaveBeenCalled();
		expect(deps.getGroupedHandlers).not.toHaveBeenCalled();
	});

	it("resolves lazy views only when the matching command runs", async () => {
		const {
			deps,
			aboutView,
			configView,
			costView,
			feedbackView,
			fileSearchView,
			importExportView,
			queuePanelController,
			reportSelectorView,
			runCommandView,
			toolStatusView,
			diagnosticsView,
			thinkingSelectorView,
			clearController,
			customCommandsController,
			branchController,
		} = createDeps();
		const options = buildTuiCommandRegistryOptions(deps);

		options.getRunScriptCompletions("te");
		expect(deps.getRunCommandView).toHaveBeenCalledTimes(1);
		expect(runCommandView.getRunScriptCompletions).toHaveBeenCalledTimes(1);

		options.handlers.about(createCommandContext("/about"));
		expect(deps.getAboutView).toHaveBeenCalledTimes(1);
		expect(aboutView.handleAboutCommand).toHaveBeenCalledTimes(1);

		options.handlers.config(createCommandContext("/config", "summary"));
		expect(deps.getConfigView).toHaveBeenCalledTimes(1);
		expect(configView.handleConfigCommand).toHaveBeenCalledTimes(1);

		options.handlers.cost(createCommandContext("/cost", "today"));
		expect(deps.getCostView).toHaveBeenCalledTimes(1);
		expect(costView.handleCostCommand).toHaveBeenCalledTimes(1);

		await options.handlers.clear(createCommandContext("/clear"));
		expect(deps.getClearController).toHaveBeenCalledTimes(1);
		expect(clearController.handleClearCommand).toHaveBeenCalledTimes(1);

		options.handlers.run(createCommandContext("/run test", "test"));
		expect(deps.getRunCommandView).toHaveBeenCalledTimes(2);
		expect(runCommandView.handleRunCommand).toHaveBeenCalledTimes(1);

		options.handlers.tools(createCommandContext("/tools"));
		expect(deps.getToolStatusView).toHaveBeenCalledTimes(1);
		expect(toolStatusView.handleToolsCommand).toHaveBeenCalledTimes(1);

		options.handlers.status(createCommandContext("/status"));
		expect(deps.getDiagnosticsView).toHaveBeenCalledTimes(1);
		expect(diagnosticsView.handleStatusCommand).toHaveBeenCalledTimes(1);

		await options.handlers.diagnostics(createCommandContext("/diag"));
		expect(deps.getDiagnosticsView).toHaveBeenCalledTimes(2);
		expect(diagnosticsView.handleDiagnosticsCommand).toHaveBeenCalledTimes(1);

		options.handlers.mention(createCommandContext("/mention src", "src"));
		expect(deps.getFileSearchView).toHaveBeenCalledTimes(1);
		expect(fileSearchView.handleMentionCommand).toHaveBeenCalledTimes(1);

		options.handlers.queue(createCommandContext("/queue"));
		expect(deps.getQueuePanelController).toHaveBeenCalledTimes(1);
		expect(queuePanelController.handleQueueCommand).toHaveBeenCalledTimes(1);

		options.handlers.branch(createCommandContext("/branch"));
		expect(deps.getBranchController).toHaveBeenCalledTimes(1);
		expect(branchController.handleBranchCommand).toHaveBeenCalledTimes(1);

		await options.handlers.importConfig(
			createCommandContext("/import", "config"),
		);
		expect(deps.getImportExportView).toHaveBeenCalledTimes(1);
		expect(importExportView.handleImportCommand).toHaveBeenCalledTimes(1);

		options.handlers.report(createCommandContext("/report"));
		expect(deps.getReportSelectorView).toHaveBeenCalledTimes(1);
		expect(reportSelectorView.show).toHaveBeenCalledTimes(1);
		expect(deps.getFeedbackView).not.toHaveBeenCalled();

		options.handlers.report(
			createCommandContext("/report bug", "bug", { type: "bug" }),
		);
		expect(deps.getFeedbackView).toHaveBeenCalledTimes(1);
		expect(feedbackView.handleBugCommand).toHaveBeenCalledTimes(1);

		options.handlers.commands(createCommandContext("/commands", "list"));
		expect(deps.getCustomCommandsController).toHaveBeenCalledTimes(1);
		expect(
			customCommandsController.handleCommandsCommand,
		).toHaveBeenCalledTimes(1);

		options.handlers.prompts(createCommandContext("/prompts", "list"));
		expect(deps.getCustomCommandsController).toHaveBeenCalledTimes(2);
		expect(customCommandsController.handlePromptsCommand).toHaveBeenCalledTimes(
			1,
		);

		options.handlers.thinking(createCommandContext("/thinking"));
		expect(deps.getThinkingSelectorView).toHaveBeenCalledTimes(1);
		expect(thinkingSelectorView.show).toHaveBeenCalledTimes(1);

		expect(options.getGroupedHandlers()).toBeDefined();
		expect(deps.getGroupedHandlers).toHaveBeenCalledTimes(1);
	});
});
