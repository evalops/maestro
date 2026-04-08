import { describe, expect, it, vi } from "vitest";
import {
	type WebSlashCommandContext,
	executeWebSlashCommand,
} from "../../packages/web/src/components/composer-chat-slash-commands.js";

function createContext(
	overrides: Partial<WebSlashCommandContext> = {},
): WebSlashCommandContext {
	return {
		apiClient: {
			addPackage: vi.fn(),
			cancelQueuedPrompt: vi.fn(),
			clearMemory: vi.fn(),
			createBranch: vi.fn(),
			deleteMemory: vi.fn(),
			enterPlanMode: vi.fn(),
			exitPlanMode: vi.fn(),
			exportMemory: vi.fn(),
			getApprovalMode: vi.fn(),
			getConfig: vi.fn(),
			getDiagnostics: vi.fn(),
			getFiles: vi.fn(),
			getMemoryStats: vi.fn(),
			getPackageStatus: vi.fn(),
			getPlan: vi.fn(),
			getPreview: vi.fn(),
			getQueueStatus: vi.fn(),
			getRecentMemories: vi.fn(),
			getReview: vi.fn(),
			getRunScripts: vi.fn(),
			getStats: vi.fn(),
			getStatus: vi.fn(),
			getTelemetryStatus: vi.fn(),
			getUsage: vi.fn(),
			inspectPackage: vi.fn(),
			listBranchOptions: vi.fn(),
			listMemoryTopic: vi.fn(),
			listMemoryTopics: vi.fn(),
			listQueue: vi.fn(),
			importMemory: vi.fn(),
			removePackage: vi.fn(),
			runScript: vi.fn(),
			saveMemory: vi.fn(),
			saveConfig: vi.fn(),
			searchMemory: vi.fn(),
			setApprovalMode: vi.fn(),
			setCleanMode: vi.fn(),
			setFooterMode: vi.fn(),
			setModel: vi.fn(),
			setQueueMode: vi.fn(),
			setTelemetry: vi.fn(),
			setZenMode: vi.fn(),
			updatePlan: vi.fn(),
			validatePackage: vi.fn(),
		},
		appendCommandOutput: vi.fn(),
		applyTheme: vi.fn(),
		applyZenMode: vi.fn(),
		commands: [],
		createNewSession: vi.fn(),
		currentSessionId: null,
		isSharedSession: false,
		openCommandDrawer: vi.fn(),
		openModelSelector: vi.fn(),
		selectSession: vi.fn(),
		setApprovalModeStatus: vi.fn(),
		setCleanMode: vi.fn(),
		setCurrentModel: vi.fn(),
		setFooterMode: vi.fn(),
		setInputValue: vi.fn(),
		setQueueMode: vi.fn(),
		setTransportPreference: vi.fn(),
		theme: "dark",
		updateModelMeta: vi.fn(),
		zenMode: false,
		...overrides,
	};
}

describe("web approvals slash command", () => {
	it("updates approval status state after setting a stricter-resolved mode", async () => {
		const context = createContext();
		vi.mocked(context.apiClient.setApprovalMode).mockResolvedValue({
			success: true,
			mode: "fail",
			message:
				"Approval mode resolved to fail because the server default is stricter",
		});

		await executeWebSlashCommand("approvals", "auto", context);

		expect(context.setApprovalModeStatus).toHaveBeenCalledWith({
			mode: "fail",
			message:
				"Approval mode resolved to fail because the server default is stricter",
			notify: true,
			sessionId: null,
		});
	});

	it("updates approval status state when reading the current mode", async () => {
		const context = createContext({ currentSessionId: "session-42" });
		vi.mocked(context.apiClient.getApprovalMode).mockResolvedValue({
			mode: "prompt",
			availableModes: ["auto", "prompt", "fail"],
		});

		await executeWebSlashCommand("approvals", "", context);

		expect(context.setApprovalModeStatus).toHaveBeenCalledWith({
			mode: "prompt",
			sessionId: "session-42",
		});
	});
});
