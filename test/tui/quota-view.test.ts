import { Text } from "@evalops/tui";
import { Container, type TUI } from "@evalops/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../../src/tui/commands/types.js";
import { QuotaView } from "../../src/tui/status/quota-view.js";

vi.mock("../../src/db/client.js", () => ({
	isDatabaseConfigured: vi.fn(() => false),
	getDb: vi.fn(),
}));

vi.mock("../../src/billing/token-tracker.js", () => ({
	getUsageQuota: vi.fn(),
	getOrgUsageSummary: vi.fn(),
}));

vi.mock("../../src/auth/jwt.js", () => ({
	verifyToken: vi.fn(),
}));

import { verifyToken } from "../../src/auth/jwt.js";
import {
	getOrgUsageSummary,
	getUsageQuota,
} from "../../src/billing/token-tracker.js";
import { isDatabaseConfigured } from "../../src/db/client.js";

const mockIsDatabaseConfigured = vi.mocked(isDatabaseConfigured);
const mockGetUsageQuota = vi.mocked(getUsageQuota);
const mockGetOrgUsageSummary = vi.mocked(getOrgUsageSummary);
const mockVerifyToken = vi.mocked(verifyToken);

const createContext = (
	rawInput: string,
	overrides: Partial<CommandExecutionContext<Record<string, unknown>>> = {},
): CommandExecutionContext<Record<string, unknown>> => {
	const argumentText = rawInput.includes(" ")
		? rawInput.slice(rawInput.indexOf(" ") + 1).trim()
		: "";
	return {
		command: { name: "quota" },
		rawInput,
		argumentText,
		parsedArgs: overrides.parsedArgs,
		showInfo: overrides.showInfo ?? vi.fn(),
		showError: overrides.showError ?? vi.fn(),
		renderHelp: overrides.renderHelp ?? vi.fn(),
	};
};

const createQuotaView = (
	overrides: {
		showInfo?: ReturnType<typeof vi.fn>;
		showError?: ReturnType<typeof vi.fn>;
		getSessionTokenUsage?: () => number;
	} = {},
) => {
	const container = new Container();
	const showInfo = overrides.showInfo ?? vi.fn();
	const showError = overrides.showError ?? vi.fn();
	const getSessionTokenUsage = overrides.getSessionTokenUsage ?? (() => 5000);

	const view = new QuotaView({
		chatContainer: container,
		ui: { requestRender: vi.fn() } as unknown as TUI,
		showInfo,
		showError,
		getSessionTokenUsage,
	});

	return { view, container, showInfo, showError };
};

const getRenderedText = (container: Container): string => {
	const textComponent = container.children.find(
		(child): child is Text => child instanceof Text,
	);
	return textComponent?.render(120).join("\n") ?? "";
};

describe("QuotaView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsDatabaseConfigured.mockReturnValue(false);
	});

	describe("non-enterprise mode (no database)", () => {
		it("shows session usage when no limit is set", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 12345,
			});

			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Token Quota");
			expect(rendered).toContain("Session Usage");
			expect(rendered).toContain("12.3K");
			expect(rendered).toContain("database configuration");
		});

		it("shows session limit status when limit is active", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 45000,
			});

			// Set a limit first
			view.handleQuotaCommand(createContext("/quota limit 100000"));

			// Clear container children to check status output
			container.children.length = 0;
			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Session Limit");
			expect(rendered).toContain("Active");
			expect(rendered).toContain("45.0K");
			expect(rendered).toContain("100.0K");
		});

		it("shows warning color when usage exceeds 80%", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 85000,
			});

			view.handleQuotaCommand(createContext("/quota limit 100000"));
			container.children.length = 0;
			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("85.0%");
		});
	});

	describe("/quota limit command", () => {
		it("sets a session token limit", () => {
			const { view, showInfo } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit 50000"));

			expect(showInfo).toHaveBeenCalledWith(expect.stringContaining("50.0K"));
			expect(view.getSessionLimit().enabled).toBe(true);
			expect(view.getSessionLimit().maxTokens).toBe(50000);
		});

		it("disables limit with 'off'", () => {
			const { view, showInfo } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit 50000"));
			view.handleQuotaCommand(createContext("/quota limit off"));

			expect(showInfo).toHaveBeenCalledWith(
				expect.stringContaining("disabled"),
			);
			expect(view.getSessionLimit().enabled).toBe(false);
		});

		it("disables limit with 'disable'", () => {
			const { view, showInfo } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit 50000"));
			view.handleQuotaCommand(createContext("/quota limit disable"));

			expect(view.getSessionLimit().enabled).toBe(false);
		});

		it("disables limit with 'clear'", () => {
			const { view, showInfo } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit 50000"));
			view.handleQuotaCommand(createContext("/quota limit clear"));

			expect(view.getSessionLimit().enabled).toBe(false);
		});

		it("shows error for invalid limit value", () => {
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit abc"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Invalid limit"),
			);
		});

		it("shows error for zero limit", () => {
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit 0"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("positive number"),
			);
		});

		it("shows error for negative limit", () => {
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit -100"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("positive number"),
			);
		});

		it("shows error for limit exceeding MAX_SAFE_INTEGER", () => {
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(
				createContext(`/quota limit ${Number.MAX_SAFE_INTEGER + 1}`),
			);

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("positive number"),
			);
		});

		it("shows current limit status when called without args", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 25000,
			});

			view.handleQuotaCommand(createContext("/quota limit 50000"));
			container.children.length = 0;
			view.handleQuotaCommand(createContext("/quota limit"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Session Limit");
			expect(rendered).toContain("50.0K");
			expect(rendered).toContain("25.0K");
		});

		it("shows no limit message when no limit is set", () => {
			const { view, container } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota limit"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("No session limit set");
		});
	});

	describe("isOverLimit()", () => {
		it("returns false when no limit is set", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 100000,
			});

			expect(view.isOverLimit()).toBe(false);
		});

		it("returns false when under limit", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 40000,
			});

			view.handleQuotaCommand(createContext("/quota limit 50000"));

			expect(view.isOverLimit()).toBe(false);
		});

		it("returns true when at limit", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 50000,
			});

			view.handleQuotaCommand(createContext("/quota limit 50000"));

			expect(view.isOverLimit()).toBe(true);
		});

		it("returns true when over limit", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 60000,
			});

			view.handleQuotaCommand(createContext("/quota limit 50000"));

			expect(view.isOverLimit()).toBe(true);
		});
	});

	describe("getSessionLimit()", () => {
		it("returns current limit state with token usage", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 30000,
			});

			view.handleQuotaCommand(createContext("/quota limit 50000"));

			const limit = view.getSessionLimit();
			expect(limit.enabled).toBe(true);
			expect(limit.maxTokens).toBe(50000);
			expect(limit.tokensUsed).toBe(30000);
		});

		it("returns disabled state when no limit set", () => {
			const { view } = createQuotaView({
				getSessionTokenUsage: () => 10000,
			});

			const limit = view.getSessionLimit();
			expect(limit.enabled).toBe(false);
			expect(limit.maxTokens).toBe(0);
			expect(limit.tokensUsed).toBe(10000);
		});
	});

	describe("/quota help command", () => {
		it("renders help text", () => {
			const { view, container } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota help"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("/quota");
			expect(rendered).toContain("detailed");
			expect(rendered).toContain("models");
			expect(rendered).toContain("alerts");
			expect(rendered).toContain("limit");
		});
	});

	describe("enterprise mode (with database)", () => {
		beforeEach(() => {
			mockIsDatabaseConfigured.mockReturnValue(true);
		});

		it("shows not authenticated message when no token", async () => {
			const { view, container } = createQuotaView();
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_ENTERPRISE_TOKEN;

			await view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Not authenticated");
		});

		it("shows quota status for authenticated user", async () => {
			process.env.COMPOSER_ENTERPRISE_TOKEN = "test-token";
			mockVerifyToken.mockReturnValue({
				userId: "user-123",
				orgId: "org-456",
				email: "test@example.com",
				roleId: "role-789",
				type: "access",
			});
			mockGetUsageQuota.mockResolvedValue({
				userId: "user-123",
				orgId: "org-456",
				tokenQuota: 100000,
				tokenUsed: 45000,
				tokenRemaining: 55000,
				spendLimit: null,
				spendUsed: 0,
				spendRemaining: Number.POSITIVE_INFINITY,
				quotaResetAt: new Date("2025-12-01"),
			});

			const { view, container } = createQuotaView();

			await view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Token Quota Status");
			expect(rendered).toContain("45.0K");
			expect(rendered).toContain("100.0K");

			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_ENTERPRISE_TOKEN;
		});

		it("shows unlimited quota status", async () => {
			process.env.COMPOSER_ENTERPRISE_TOKEN = "test-token";
			mockVerifyToken.mockReturnValue({
				userId: "user-123",
				orgId: "org-456",
				email: "test@example.com",
				roleId: "role-789",
				type: "access",
			});
			mockGetUsageQuota.mockResolvedValue({
				userId: "user-123",
				orgId: "org-456",
				tokenQuota: null,
				tokenUsed: 250000,
				tokenRemaining: Number.POSITIVE_INFINITY,
				spendLimit: null,
				spendUsed: 0,
				spendRemaining: Number.POSITIVE_INFINITY,
				quotaResetAt: null,
			});

			const { view, container } = createQuotaView();

			await view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Unlimited");

			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_ENTERPRISE_TOKEN;
		});

		it("handles zero quota as unlimited (prevents division by zero)", async () => {
			process.env.COMPOSER_ENTERPRISE_TOKEN = "test-token";
			mockVerifyToken.mockReturnValue({
				userId: "user-123",
				orgId: "org-456",
				email: "test@example.com",
				roleId: "role-789",
				type: "access",
			});
			mockGetUsageQuota.mockResolvedValue({
				userId: "user-123",
				orgId: "org-456",
				tokenQuota: 0,
				tokenUsed: 1000,
				tokenRemaining: 0,
				spendLimit: null,
				spendUsed: 0,
				spendRemaining: Number.POSITIVE_INFINITY,
				quotaResetAt: null,
			});

			const { view, container } = createQuotaView();

			await view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Unlimited");
			expect(rendered).not.toContain("Infinity");

			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_ENTERPRISE_TOKEN;
		});

		it("shows error for enterprise commands without database", () => {
			mockIsDatabaseConfigured.mockReturnValue(false);
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota detailed"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("enterprise database"),
			);
		});

		it("shows error for models command without database", () => {
			mockIsDatabaseConfigured.mockReturnValue(false);
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota models"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("enterprise database"),
			);
		});

		it("shows error for alerts command without database", () => {
			mockIsDatabaseConfigured.mockReturnValue(false);
			const { view, showError } = createQuotaView();

			view.handleQuotaCommand(createContext("/quota alerts"));

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("enterprise database"),
			);
		});
	});

	describe("formatTokens helper", () => {
		it("formats small numbers without suffix", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 500,
			});

			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("500");
		});

		it("formats thousands with K suffix", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 5500,
			});

			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("5.5K");
		});

		it("formats millions with M suffix", () => {
			const { view, container } = createQuotaView({
				getSessionTokenUsage: () => 1500000,
			});

			view.handleQuotaCommand(createContext("/quota"));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("1.5M");
		});
	});

	describe("session limit with session override", () => {
		it("shows session override notice in enterprise mode", async () => {
			process.env.COMPOSER_ENTERPRISE_TOKEN = "test-token";
			mockIsDatabaseConfigured.mockReturnValue(true);
			mockVerifyToken.mockReturnValue({
				userId: "user-123",
				orgId: "org-456",
				email: "test@example.com",
				roleId: "role-789",
				type: "access",
			});
			mockGetUsageQuota.mockResolvedValue({
				userId: "user-123",
				orgId: "org-456",
				tokenQuota: 100000,
				tokenUsed: 45000,
				tokenRemaining: 55000,
				spendLimit: null,
				spendUsed: 0,
				spendRemaining: Number.POSITIVE_INFINITY,
				quotaResetAt: null,
			});

			const { view, container } = createQuotaView();

			// Set a local session limit
			view.handleQuotaCommand(createContext("/quota limit 25000"));

			container.children.length = 0;
			view.handleQuotaCommand(createContext("/quota"));

			await new Promise((resolve) => setTimeout(resolve, 10));

			const rendered = getRenderedText(container);
			expect(rendered).toContain("Session Override");
			expect(rendered).toContain("25.0K");

			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_ENTERPRISE_TOKEN;
		});
	});
});
