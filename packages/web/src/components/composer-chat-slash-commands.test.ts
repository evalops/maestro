import { describe, expect, it, vi } from "vitest";
import {
	type WebSlashCommandContext,
	executeWebSlashCommand,
} from "./composer-chat-slash-commands.js";
import { WEB_SLASH_COMMANDS } from "./slash-commands.js";

type CommandOutput = {
	output: string;
	isError: boolean;
};

function createContext(overrides: Partial<WebSlashCommandContext> = {}) {
	const outputs: CommandOutput[] = [];
	const apiClient = {
		cancelQueuedPrompt: vi.fn(),
		createBranch: vi.fn(),
		enterPlanMode: vi.fn(),
		exitPlanMode: vi.fn(),
		getApprovalMode: vi.fn(),
		getConfig: vi.fn(),
		getDiagnostics: vi.fn(),
		getFiles: vi.fn(),
		getPlan: vi.fn(),
		getPreview: vi.fn(),
		getQueueStatus: vi.fn(),
		getReview: vi.fn(),
		getRunScripts: vi.fn(),
		getStats: vi.fn(),
		getStatus: vi.fn(),
		getTelemetryStatus: vi.fn(),
		getUsage: vi.fn(),
		listBranchOptions: vi.fn(),
		listQueue: vi.fn(),
		runScript: vi.fn(),
		saveConfig: vi.fn(),
		setApprovalMode: vi.fn(),
		setCleanMode: vi.fn(),
		setFooterMode: vi.fn(),
		setModel: vi.fn(),
		setQueueMode: vi.fn(),
		setTelemetry: vi.fn(),
		setZenMode: vi.fn(),
		updatePlan: vi.fn(),
	};

	const context: WebSlashCommandContext = {
		apiClient: apiClient as unknown as WebSlashCommandContext["apiClient"],
		appendCommandOutput: (output, isError = false) => {
			outputs.push({ output, isError });
		},
		applyTheme: vi.fn(),
		applyZenMode: vi.fn(),
		commands: WEB_SLASH_COMMANDS,
		createNewSession: vi.fn().mockResolvedValue(undefined),
		currentSessionId: "session-1",
		isSharedSession: false,
		openCommandDrawer: vi.fn(),
		openModelSelector: vi.fn(),
		selectSession: vi.fn().mockResolvedValue(undefined),
		setCleanMode: vi.fn(),
		setCurrentModel: vi.fn(),
		setFooterMode: vi.fn(),
		setInputValue: vi.fn(),
		setQueueMode: vi.fn(),
		setTransportPreference: vi.fn(),
		theme: "dark",
		updateModelMeta: vi.fn().mockResolvedValue(undefined),
		zenMode: false,
		...overrides,
	};

	return { context, outputs, apiClient };
}

describe("executeWebSlashCommand", () => {
	it("renders the help command list as a code block", async () => {
		const { context, outputs } = createContext();

		await executeWebSlashCommand("help", "", context);

		expect(outputs).toEqual([
			expect.objectContaining({
				isError: false,
				output: expect.stringContaining(
					"/stats — Show status and usage summary",
				),
			}),
		]);
		expect(outputs[0]?.output).toContain("```text");
	});

	it("blocks branch creation in shared sessions", async () => {
		const { context, outputs, apiClient } = createContext({
			isSharedSession: true,
		});

		await executeWebSlashCommand("branch", "7", context);

		expect(apiClient.createBranch).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: "Branching is disabled in shared sessions.",
				isError: true,
			},
		]);
	});

	it("opens the command drawer without appending output", async () => {
		const { context, outputs } = createContext();

		await executeWebSlashCommand("commands", "", context);

		expect(context.openCommandDrawer).toHaveBeenCalledOnce();
		expect(outputs).toEqual([]);
	});

	it("updates model state when a model is provided", async () => {
		const { context, outputs, apiClient } = createContext();

		await executeWebSlashCommand("model", "anthropic/claude-opus", context);

		expect(apiClient.setModel).toHaveBeenCalledWith("anthropic/claude-opus");
		expect(context.setCurrentModel).toHaveBeenCalledWith(
			"anthropic/claude-opus",
		);
		expect(context.updateModelMeta).toHaveBeenCalledOnce();
		expect(outputs).toEqual([
			{
				output: "Model set to anthropic/claude-opus",
				isError: false,
			},
		]);
	});

	it("inserts custom command prompts by command name", async () => {
		const customCommand = {
			name: "triage",
			description: "Triage an issue",
			usage: "/triage issue=<value>",
			source: "custom" as const,
			prompt: "Triage issue {{issue}}",
			args: [{ name: "issue", required: true }],
		};
		const setInputValue = vi.fn();
		const { context, outputs } = createContext({
			commands: [...WEB_SLASH_COMMANDS, customCommand],
			setInputValue,
		});

		await executeWebSlashCommand("triage", "issue=42", context);

		expect(setInputValue).toHaveBeenCalledWith("Triage issue 42");
		expect(outputs).toEqual([
			{
				output: 'Inserted command "triage". Edit then submit.',
				isError: false,
			},
		]);
	});

	it("validates custom /commands run invocations", async () => {
		const customCommand = {
			name: "triage",
			description: "Triage an issue",
			usage: "/triage issue=<value>",
			source: "custom" as const,
			prompt: "Triage issue {{issue}}",
			args: [{ name: "issue", required: true }],
		};
		const setInputValue = vi.fn();
		const { context, outputs } = createContext({
			commands: [...WEB_SLASH_COMMANDS, customCommand],
			setInputValue,
		});

		await executeWebSlashCommand("commands", "run triage", context);

		expect(setInputValue).not.toHaveBeenCalled();
		expect(outputs).toEqual([
			{
				output: "Missing required arg: issue\nUsage: /triage issue=<value>",
				isError: true,
			},
		]);
	});
});
