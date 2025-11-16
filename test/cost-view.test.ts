import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSummary } from "../src/tracking/cost-tracker.js";
import { Text } from "../src/tui-lib/components/text.js";
import { Container, type TUI } from "../src/tui-lib/tui.js";
import { CostView } from "../src/tui/cost-view.js";

vi.mock("../src/tracking/cost-tracker.js", () => ({
	getUsageSummary: vi.fn(),
}));

import { getUsageSummary } from "../src/tracking/cost-tracker.js";

const mockSummary = vi.mocked(getUsageSummary);

const makeSummary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
	totalCost: 12.3456,
	totalRequests: 4,
	totalTokens: 12345,
	byProvider: {
		anthropic: { cost: 8, requests: 3, tokens: 8000 },
		openai: { cost: 4.3456, requests: 1, tokens: 4345 },
	},
	byModel: {
		"anthropic/claude-sonnet-4-5": { cost: 6, requests: 2, tokens: 5000 },
		"anthropic/claude-haiku-4": { cost: 2, requests: 1, tokens: 3000 },
		"openai/gpt-4.1": { cost: 4.3456, requests: 1, tokens: 4345 },
	},
	...overrides,
});

describe("CostView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSummary.mockReturnValue(makeSummary());
	});

	it("renders overview and provider breakdown", () => {
		const container = new Container();
		const requestRender = vi.fn();
		const showInfo = vi.fn();
		const view = new CostView({
			chatContainer: container,
			ui: { requestRender } as unknown as TUI,
			showInfo,
			showError: vi.fn(),
		});

		view.handleCostCommand("/cost today");

		expect(mockSummary).toHaveBeenCalledWith(
			expect.objectContaining({ since: expect.any(Number) }),
		);
		const textComponent = container.children.find(
			(child): child is Text => child instanceof Text,
		);
		expect(textComponent).toBeDefined();
		const rendered = textComponent?.render(120).join("\n") ?? "";
		expect(rendered).toContain("Cost Summary");
		expect(rendered.toLowerCase()).toContain("anthropic");
		expect(rendered).toContain("Top models");
		expect(showInfo).not.toHaveBeenCalled();
	});

	it("falls back to all time for unknown period and informs user", () => {
		const container = new Container();
		const showInfo = vi.fn();
		const view = new CostView({
			chatContainer: container,
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showInfo,
			showError: vi.fn(),
		});

		view.handleCostCommand("/cost nonsense");

		expect(showInfo).toHaveBeenCalledWith(expect.stringContaining("nonsense"));
		expect(mockSummary).toHaveBeenCalledWith({});
	});

	it("shows empty state when no requests recorded", () => {
		mockSummary.mockReturnValueOnce(
			makeSummary({ totalRequests: 0, totalTokens: 0, totalCost: 0 }),
		);
		const container = new Container();
		const view = new CostView({
			chatContainer: container,
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showInfo: vi.fn(),
			showError: vi.fn(),
		});

		view.handleCostCommand("/cost");

		const textComponent = container.children.find(
			(child): child is Text => child instanceof Text,
		);
		const rendered = textComponent?.render(80).join("\n") ?? "";
		expect(rendered).toContain("No usage data");
	});

	it("surfaces errors from usage summary", () => {
		const showError = vi.fn();
		mockSummary.mockImplementationOnce(() => {
			throw new Error("disk error");
		});
		const view = new CostView({
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showInfo: vi.fn(),
			showError,
		});

		view.handleCostCommand("/cost week");

		expect(showError).toHaveBeenCalledWith(
			expect.stringContaining("disk error"),
		);
	});
});
