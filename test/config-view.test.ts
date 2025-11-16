import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ConfigInspection,
	ConfigValidationResult,
} from "../src/models/registry.js";
import { Text } from "../src/tui-lib/components/text.js";
import { Container, type TUI } from "../src/tui-lib/tui.js";
import { ConfigView } from "../src/tui/config-view.js";

vi.mock("../src/models/registry.js", () => ({
	validateConfig: vi.fn(),
	inspectConfig: vi.fn(),
	getConfigHierarchy: vi.fn(),
}));

import {
	getConfigHierarchy,
	inspectConfig,
	validateConfig,
} from "../src/models/registry.js";

const mockValidate = vi.mocked(validateConfig);
const mockInspect = vi.mocked(inspectConfig);
const mockHierarchy = vi.mocked(getConfigHierarchy);

const TEST_HIERARCHY = ["/home/user/.composer/config.json"];

const createValidation = (): ConfigValidationResult => ({
	valid: false,
	errors: ["File reference not found: /missing/prompt.md"],
	warnings: ["Environment variable ANTHROPIC_API_KEY not set"],
	summary: {
		configFiles: [...TEST_HIERARCHY],
		providers: 1,
		models: 2,
		fileReferences: ["/missing/prompt.md"],
		envVars: ["ANTHROPIC_API_KEY"],
	},
});

const createInspection = (): ConfigInspection => ({
	sources: [
		{ path: TEST_HIERARCHY[0], exists: true, loaded: true },
		{
			path: "/tmp/project/.composer/config.json",
			exists: false,
			loaded: false,
		},
	],
	providers: [
		{
			id: "anthropic",
			name: "Anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKeySource: "env:ANTHROPIC_API_KEY",
			modelCount: 2,
			models: [
				{ id: "claude-sonnet-4-5", name: "Sonnet" },
				{ id: "claude-haiku-4", name: "Haiku" },
			],
		},
	],
	fileReferences: [
		{
			path: "/home/user/.composer/prompts/system.md",
			exists: true,
			size: 1024,
		},
	],
	envVars: [
		{ name: "ANTHROPIC_API_KEY", set: true, maskedValue: "sk-test" },
		{ name: "OPENAI_API_KEY", set: false },
	],
});

describe("ConfigView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockValidate.mockImplementation(() => createValidation());
		mockInspect.mockImplementation(() => createInspection());
		mockHierarchy.mockReturnValue([...TEST_HIERARCHY]);
	});

	it("renders validation, providers, and env sections", () => {
		const container = new Container();
		const requestRender = vi.fn();
		const view = new ConfigView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showError: vi.fn(),
		});

		view.showConfigSummary();

		expect(requestRender).toHaveBeenCalled();
		const textComponent = container.children.find(
			(component): component is Text => component instanceof Text,
		);
		expect(textComponent).toBeDefined();
		const rendered = textComponent?.render(120).join("\n") ?? "";
		expect(rendered).toContain("Composer configuration");
		expect(rendered).toContain("Anthropic");
		expect(rendered).toContain("API key");
		expect(rendered).toContain("Environment variables");
		expect(mockValidate).toHaveBeenCalled();
		expect(mockInspect).toHaveBeenCalled();
		expect(mockHierarchy).toHaveBeenCalled();
	});

	it("surfaces errors from inspection", () => {
		const container = new Container();
		const showError = vi.fn();
		mockValidate.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const view = new ConfigView({
			chatContainer: container,
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showError,
		});

		view.showConfigSummary();

		expect(showError).toHaveBeenCalledWith(expect.stringContaining("boom"));
		expect(container.children).toHaveLength(0);
	});
});
