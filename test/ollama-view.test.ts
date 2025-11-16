import { beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "../src/tui-lib/components/text.js";
import { Container, type TUI } from "../src/tui-lib/tui.js";
import { OllamaView } from "../src/tui/ollama-view.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

import { spawnSync } from "node:child_process";

const mockSpawn = vi.mocked(spawnSync);

const createView = () => {
	const container = new Container();
	const requestRender = vi.fn();
	const showInfoMessage = vi.fn();
	const showErrorMessage = vi.fn();
	const view = new OllamaView({
		chatContainer: container,
		ui: { requestRender } as unknown as TUI,
		showInfoMessage,
		showErrorMessage,
	});
	return { container, requestRender, showInfoMessage, showErrorMessage, view };
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
		expect(rendered).toContain("/ollama pull");
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

	it("surfaces errors when model argument is missing for pull", () => {
		const { showInfoMessage, view } = createView();
		view.handleOllamaCommand("/ollama pull");
		expect(showInfoMessage).toHaveBeenCalledWith("Usage: /ollama pull <model>");
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
