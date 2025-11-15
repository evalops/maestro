import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredModel } from "../src/models/registry.js";
import { Text } from "../src/tui-lib/components/text.js";
import { Container, type TUI } from "../src/tui-lib/tui.js";
import { OllamaView } from "../src/tui/ollama-view.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

import { spawnSync } from "node:child_process";

const mockSpawn = vi.mocked(spawnSync);

const LOCAL_MODELS: RegisteredModel[] = [
	{
		id: "ollama/llama3",
		name: "llama3",
		api: "openai-responses",
		provider: "ollama",
		providerName: "Ollama (local)",
		baseUrl: "http://localhost:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		source: "custom",
		isLocal: true,
	},
	{
		id: "local/codellama",
		name: "codellama",
		api: "openai-responses",
		provider: "local",
		providerName: "Local",
		baseUrl: "http://localhost:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		source: "custom",
		isLocal: true,
	},
];

const createView = (models: RegisteredModel[] = LOCAL_MODELS) => {
	const container = new Container();
	const requestRender = vi.fn();
	const showInfoMessage = vi.fn();
	const showErrorMessage = vi.fn();
	const onUseModel = vi.fn();
	const view = new OllamaView({
		chatContainer: container,
		ui: { requestRender } as unknown as TUI,
		showInfoMessage,
		showErrorMessage,
		getRegisteredModels: () => models,
		onUseModel,
	});
	return {
		container,
		requestRender,
		showInfoMessage,
		showErrorMessage,
		view,
		onUseModel,
	};
};

describe("OllamaView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);
	});

	it("renders usage when no arguments are provided", () => {
		const { container, view } = createView();
		view.handleOllamaCommand("/ollama");
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("/ollama list");
		expect(rendered).toContain("/ollama use");
	});

	it("runs ollama list and prints output", () => {
		mockSpawn.mockReturnValueOnce({
			status: 0,
			stdout: "NAME\nllama3\n",
			stderr: "",
		} as any);
		const { container, view } = createView();
		view.handleOllamaCommand("/ollama list");
		expect(mockSpawn).toHaveBeenCalledWith(
			"ollama",
			["list"],
			expect.objectContaining({ encoding: "utf-8" }),
		);
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("llama3");
	});

	it("suggests popular models when pull target missing", () => {
		const { showInfoMessage, view } = createView();
		view.handleOllamaCommand("/ollama pull");
		expect(showInfoMessage).toHaveBeenCalledWith(
			expect.stringContaining("Popular models"),
		);
	});

	it("supports ollama show", () => {
		const { view } = createView();
		view.handleOllamaCommand("/ollama show llama3");
		expect(mockSpawn).toHaveBeenCalledWith(
			"ollama",
			["show", "llama3"],
			expect.any(Object),
		);
	});

	it("switches to a local model via use command", () => {
		const { onUseModel, view } = createView();
		view.handleOllamaCommand("/ollama use llama3");
		expect(onUseModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "ollama/llama3" }),
		);
	});

	it("warns when matching local model is not found", () => {
		const { showInfoMessage, view } = createView([]);
		view.handleOllamaCommand("/ollama use llama3");
		expect(showInfoMessage).toHaveBeenCalledWith(
			expect.stringContaining("Could not find a local model"),
		);
	});

	it("alerts when Ollama CLI is missing", () => {
		mockSpawn.mockReturnValueOnce({
			status: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		} as any);
		const { showErrorMessage, view } = createView();
		view.handleOllamaCommand("/ollama list");
		expect(showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Ollama CLI not found"),
		);
	});
});
