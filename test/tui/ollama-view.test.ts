import type { SpawnSyncReturns } from "node:child_process";
import { Text } from "@evalops/tui";
import { Container, type TUI } from "@evalops/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaView } from "../../src/cli-tui/ollama-view.js";
import type { RegisteredModel } from "../../src/models/registry.js";

vi.mock("node:child_process", () => {
	const { EventEmitter } = require("node:events");
	return {
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
		spawn: vi.fn(() => {
			const stdout = new EventEmitter();
			const stderr = new EventEmitter();
			const emitter = new EventEmitter();
			return {
				stdout,
				stderr,
				on: emitter.on.bind(emitter),
				emit: emitter.emit.bind(emitter),
			};
		}),
	};
});

import { spawnSync } from "node:child_process";

const mockSpawnSync = vi.mocked(spawnSync);

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
		mockSpawnSync.mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
		} as SpawnSyncReturns<string>);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					Promise.resolve({
						ok: true,
						text: async () => "v1.0",
					}) as unknown as Response,
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders usage when no arguments are provided", async () => {
		const { container, view } = createView();
		await view.handleOllamaCommand("/ollama");
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("/ollama list");
		expect(rendered).toContain("/ollama use");
		expect(rendered).toContain("switch Maestro to a local model");
		expect(rendered).not.toContain("switch Composer to a local model");
	});

	it("runs ollama list and prints parsed output", async () => {
		mockSpawnSync.mockReturnValueOnce({
			status: 0,
			stdout: JSON.stringify([{ name: "llama3", size: 1024 }]),
			stderr: "",
		} as SpawnSyncReturns<string>);
		const { container, view } = createView();
		await view.handleOllamaCommand("/ollama list");
		expect(mockSpawnSync).toHaveBeenCalledWith(
			"ollama",
			["list", "--json"],
			expect.objectContaining({ encoding: "utf-8" }),
		);
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("llama3");
		expect(rendered).toContain("Maestro-ready models: highlighted");
		expect(rendered).not.toContain("Composer-ready models");
	});

	it("suggests popular models when pull target missing", async () => {
		const { showInfoMessage, view } = createView();
		await view.handleOllamaCommand("/ollama pull");
		expect(showInfoMessage).toHaveBeenCalledWith(
			expect.stringContaining("Popular models"),
		);
	});

	it("supports ollama show", async () => {
		const { view } = createView();
		await view.handleOllamaCommand("/ollama show llama3");
		expect(mockSpawnSync).toHaveBeenCalledWith(
			"ollama",
			["show", "llama3"],
			expect.any(Object),
		);
	});

	it("switches to a local model via use command", async () => {
		const { onUseModel, view } = createView();
		await view.handleOllamaCommand("/ollama use llama3");
		expect(onUseModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "ollama/llama3" }),
		);
	});

	it("warns when matching local model is not found", async () => {
		const { showInfoMessage, view } = createView([]);
		await view.handleOllamaCommand("/ollama use llama3");
		expect(showInfoMessage).toHaveBeenCalledWith(
			expect.stringContaining("Could not find a local model"),
		);
	});

	it("alerts when Ollama CLI is missing", async () => {
		mockSpawnSync.mockReturnValueOnce({
			status: null,
			stdout: "",
			stderr: "",
			pid: 0,
			output: ["", "", ""],
			signal: null,
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		} as SpawnSyncReturns<string>);
		const { showErrorMessage, view } = createView();
		await view.handleOllamaCommand("/ollama list");
		expect(showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Ollama CLI not found"),
		);
	});

	it("adds daemon hint when Ollama app is closed", async () => {
		const errorResult: SpawnSyncReturns<string> = {
			status: 1,
			stdout: "",
			stderr: "ollama server not responding - could not find ollama app",
			pid: 0,
			output: [],
			signal: null,
		};
		mockSpawnSync
			.mockReturnValueOnce(errorResult)
			.mockReturnValueOnce(errorResult);
		const { container, view } = createView();
		await view.handleOllamaCommand("/ollama list");
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("Launch the Ollama desktop app");
	});

	it("provides doctor diagnostics", async () => {
		const { container, view } = createView();
		await view.handleOllamaCommand("/ollama doctor");
		const text = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		const rendered = text?.render(120).join("\n") ?? "";
		expect(rendered).toContain("Ollama diagnostics");
	});
});
