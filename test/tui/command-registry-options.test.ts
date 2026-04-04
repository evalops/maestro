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
	const thinkingSelectorView = { show: vi.fn() };

	const deps = {
		runCommandView: {
			getRunScriptCompletions: vi.fn(() => null),
			handleRunCommand: vi.fn(),
		},
		toolStatusView: { handleToolsCommand: vi.fn() },
		sessionView: {
			handleSessionCommand: vi.fn(),
			handleSessionsCommand: vi.fn(),
		},
		clearController: { handleClearCommand: vi.fn() },
		diagnosticsView: {
			handleStatusCommand: vi.fn(),
			handleDiagnosticsCommand: vi.fn(),
		},
		gitView: { handlePreviewCommand: vi.fn() },
		backgroundTasksController: { handleBackgroundCommand: vi.fn() },
		compactionController: {
			handleCompactCommand: vi.fn(),
			handleAutocompactCommand: vi.fn(),
		},
		customCommandsController: {
			handleCommandsCommand: vi.fn(),
			handlePromptsCommand: vi.fn(),
		},
		branchController: { handleBranchCommand: vi.fn() },
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
					handleSession: vi.fn(),
					handleDiag: vi.fn(),
					handleUi: vi.fn(),
					handleSafety: vi.fn(),
					handleGit: vi.fn(),
					handleAuth: vi.fn(),
					handleUsage: vi.fn(),
					handleUndo: vi.fn(),
					handleConfig: vi.fn(),
					handleTools: vi.fn(),
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
		thinkingSelectorView,
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
		expect(deps.getThinkingSelectorView).not.toHaveBeenCalled();
		expect(deps.getFileSearchView).not.toHaveBeenCalled();
		expect(deps.getQueuePanelController).not.toHaveBeenCalled();
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
			thinkingSelectorView,
		} = createDeps();
		const options = buildTuiCommandRegistryOptions(deps);

		options.handleAbout(createCommandContext("/about"));
		expect(deps.getAboutView).toHaveBeenCalledTimes(1);
		expect(aboutView.handleAboutCommand).toHaveBeenCalledTimes(1);

		options.handleConfig(createCommandContext("/config", "summary"));
		expect(deps.getConfigView).toHaveBeenCalledTimes(1);
		expect(configView.handleConfigCommand).toHaveBeenCalledTimes(1);

		options.handleCost(createCommandContext("/cost", "today"));
		expect(deps.getCostView).toHaveBeenCalledTimes(1);
		expect(costView.handleCostCommand).toHaveBeenCalledTimes(1);

		options.handleMention(createCommandContext("/mention src", "src"));
		expect(deps.getFileSearchView).toHaveBeenCalledTimes(1);
		expect(fileSearchView.handleMentionCommand).toHaveBeenCalledTimes(1);

		options.handleQueue(createCommandContext("/queue"));
		expect(deps.getQueuePanelController).toHaveBeenCalledTimes(1);
		expect(queuePanelController.handleQueueCommand).toHaveBeenCalledTimes(1);

		await options.handleImportConfig(createCommandContext("/import", "config"));
		expect(deps.getImportExportView).toHaveBeenCalledTimes(1);
		expect(importExportView.handleImportCommand).toHaveBeenCalledTimes(1);

		options.handleReport(createCommandContext("/report"));
		expect(deps.getReportSelectorView).toHaveBeenCalledTimes(1);
		expect(reportSelectorView.show).toHaveBeenCalledTimes(1);
		expect(deps.getFeedbackView).not.toHaveBeenCalled();

		options.handleReport(
			createCommandContext("/report bug", "bug", { type: "bug" }),
		);
		expect(deps.getFeedbackView).toHaveBeenCalledTimes(1);
		expect(feedbackView.handleBugCommand).toHaveBeenCalledTimes(1);

		options.showThinkingSelector(createCommandContext("/thinking"));
		expect(deps.getThinkingSelectorView).toHaveBeenCalledTimes(1);
		expect(thinkingSelectorView.show).toHaveBeenCalledTimes(1);
	});
});
