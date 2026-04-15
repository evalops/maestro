import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
	type OAuthEditorCallbacks,
	OAuthFlowController,
	type OAuthFlowControllerOptions,
	type OAuthRenderContext,
} from "../../src/cli-tui/oauth/oauth-flow-controller.js";

// Mock the oauth module
vi.mock("../../src/oauth/index.js", () => ({
	getOAuthProviders: vi.fn().mockReturnValue([
		{ id: "anthropic", available: true },
		{ id: "openai", available: true },
	]),
	migrateOAuthCredentials: vi.fn().mockResolvedValue(undefined),
	listOAuthProviders: vi.fn().mockReturnValue([]),
	login: vi.fn().mockResolvedValue(undefined),
	logout: vi.fn().mockResolvedValue(undefined),
}));

function createMockModalManager(): OAuthFlowControllerOptions["modalManager"] {
	return {
		push: vi.fn(),
		pop: vi.fn(),
	} as unknown as OAuthFlowControllerOptions["modalManager"];
}

function createMockNotificationView(): OAuthFlowControllerOptions["notificationView"] {
	return {
		showInfo: vi.fn(),
		showToast: vi.fn(),
		showError: vi.fn(),
	} as unknown as OAuthFlowControllerOptions["notificationView"];
}

function createMockRenderContext(): OAuthRenderContext {
	return {
		chatContainer: {
			addChild: vi.fn(),
		},
		ui: {},
		requestRender: vi.fn(),
	} as unknown as OAuthRenderContext;
}

function createMockEditorCallbacks(): OAuthEditorCallbacks {
	return {
		clearEditor: vi.fn(),
		getText: vi.fn().mockReturnValue(""),
		setText: vi.fn(),
		onSubmit: undefined as ((text: string) => void) | undefined,
	};
}

describe("OAuthFlowController", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("isActive", () => {
		it("returns false initially", () => {
			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			expect(controller.isActive()).toBe(false);
		});
	});

	describe("handleLoginCommand", () => {
		it("shows error when OAuth flow is already active", async () => {
			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();

			// Start first flow
			const firstLogin = controller.handleLoginCommand("", vi.fn());

			// Try second flow while first is active
			await controller.handleLoginCommand("", showError);

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("already in progress"),
			);
		});

		it("shows error for invalid mode", async () => {
			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();
			await controller.handleLoginCommand("anthropic:invalid", showError);

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Invalid mode"),
			);
		});

		it("shows error for unknown provider", async () => {
			const { getOAuthProviders } = await import("../../src/oauth/index.js");
			(getOAuthProviders as Mock).mockReturnValue([
				{ id: "anthropic", available: true },
			]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();
			await controller.handleLoginCommand("unknown", showError);

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Unknown provider"),
			);
		});

		it("shows error when no providers available", async () => {
			const { getOAuthProviders } = await import("../../src/oauth/index.js");
			(getOAuthProviders as Mock).mockReturnValue([]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();
			await controller.handleLoginCommand("", showError);

			expect(showError).toHaveBeenCalledWith("No OAuth providers available");
		});

		it("parses mode-only argument correctly", async () => {
			const { getOAuthProviders, login } = await import(
				"../../src/oauth/index.js"
			);
			(getOAuthProviders as Mock).mockReturnValue([
				{ id: "anthropic", available: true },
			]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			await controller.handleLoginCommand("console", vi.fn());

			expect(login).toHaveBeenCalledWith(
				"anthropic",
				expect.objectContaining({ mode: "console" }),
			);
		});

		it("parses provider:mode argument correctly", async () => {
			const { getOAuthProviders, login } = await import(
				"../../src/oauth/index.js"
			);
			(getOAuthProviders as Mock).mockReturnValue([
				{ id: "anthropic", available: true },
				{ id: "openai", available: true },
			]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			await controller.handleLoginCommand("openai:pro", vi.fn());

			expect(login).toHaveBeenCalledWith(
				"openai",
				expect.objectContaining({ mode: "pro" }),
			);
		});
	});

	describe("handleLogoutCommand", () => {
		it("shows error when OAuth flow is already active", async () => {
			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();

			// Start first flow
			const firstLogout = controller.handleLogoutCommand("", vi.fn(), vi.fn());

			// Try second flow while first is active
			await controller.handleLogoutCommand("", showError, vi.fn());

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("already in progress"),
			);
		});

		it("shows info when no providers logged in", async () => {
			const { listOAuthProviders } = await import("../../src/oauth/index.js");
			(listOAuthProviders as Mock).mockReturnValue([]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showInfo = vi.fn();
			await controller.handleLogoutCommand("", vi.fn(), showInfo);

			expect(showInfo).toHaveBeenCalledWith(
				expect.stringContaining("No OAuth providers logged in"),
			);
		});

		it("shows error when specified provider not logged in", async () => {
			const { listOAuthProviders } = await import("../../src/oauth/index.js");
			(listOAuthProviders as Mock).mockReturnValue(["anthropic"]);

			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: createMockNotificationView(),
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			const showError = vi.fn();
			await controller.handleLogoutCommand("unknown", showError, vi.fn());

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Not logged in to"),
			);
		});

		it("logs out from single logged-in provider", async () => {
			const { listOAuthProviders, logout } = await import(
				"../../src/oauth/index.js"
			);
			(listOAuthProviders as Mock).mockReturnValue(["anthropic"]);

			const notificationView = createMockNotificationView();
			const controller = new OAuthFlowController({
				modalManager: createMockModalManager(),
				notificationView: notificationView,
				renderContext: createMockRenderContext(),
				editorCallbacks: createMockEditorCallbacks(),
			});

			await controller.handleLogoutCommand("", vi.fn(), vi.fn());

			expect(logout).toHaveBeenCalledWith("anthropic");
			expect(notificationView.showToast).toHaveBeenCalledWith(
				expect.stringContaining("credentials removed"),
				"success",
			);
		});
	});
});
