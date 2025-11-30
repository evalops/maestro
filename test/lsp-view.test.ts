import { beforeEach, describe, expect, it, vi } from "vitest";

type LspMocks = {
	getClients: ReturnType<typeof vi.fn>;
	shutdownAll: ReturnType<typeof vi.fn>;
	autostartLspServers: ReturnType<typeof vi.fn>;
	detectLspServers: ReturnType<typeof vi.fn>;
};

const buildView = async (features: {
	LSP_ENABLED: boolean;
	LSP_AUTOSTART?: boolean;
}) => {
	vi.resetModules();

	const getClients = vi.fn().mockResolvedValue([]);
	const shutdownAll = vi.fn().mockResolvedValue(undefined);
	const autostartLspServers = vi.fn().mockResolvedValue(undefined);
	const detectLspServers = vi.fn().mockResolvedValue([]);

	vi.doMock("../src/config/constants.js", () => ({
		FEATURES: { LSP_AUTOSTART: false, ...features },
	}));
	vi.doMock("../src/lsp/index.js", () => ({ getClients }));
	vi.doMock("../src/lsp/manager.js", () => ({
		lspManager: { shutdownAll },
	}));
	vi.doMock("../src/lsp/autostart.js", () => ({ autostartLspServers }));
	vi.doMock("../src/lsp/autodetect.js", () => ({ detectLspServers }));

	const { LspView } = await import("../src/tui/lsp-view.js");

	const chatContainer = {
		addChild: vi.fn(),
	};
	const ui = { requestRender: vi.fn() };
	const notifications = {
		showInfo: vi.fn(),
		showError: vi.fn(),
	};

	return {
		view: new LspView({
			chatContainer,
			ui,
			showInfo: notifications.showInfo,
			showError: notifications.showError,
		}),
		mocks: {
			getClients,
			shutdownAll,
			autostartLspServers,
			detectLspServers,
		} satisfies LspMocks,
		notifications,
	};
};

describe("LspView", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("aborts restart immediately when LSP is disabled", async () => {
		const { view, mocks, notifications } = await buildView({
			LSP_ENABLED: false,
		});

		await view.handleLspCommand("/lsp restart");

		expect(notifications.showError).toHaveBeenCalledWith(
			expect.stringContaining("LSP is disabled"),
		);
		expect(notifications.showInfo).not.toHaveBeenCalledWith(
			expect.stringContaining("Restarting"),
		);
		expect(mocks.shutdownAll).not.toHaveBeenCalled();
		expect(mocks.autostartLspServers).not.toHaveBeenCalled();
	});

	it("surfaces stop failure and does not attempt start during restart", async () => {
		const { view, mocks, notifications } = await buildView({
			LSP_ENABLED: true,
		});

		mocks.getClients.mockResolvedValue([
			{
				id: "ts",
				root: "/repo",
				openFiles: new Set(["/repo/index.ts"]),
				diagnostics: new Map(),
				initialized: true,
			},
		]);
		mocks.shutdownAll.mockRejectedValue(new Error("boom"));

		await view.handleLspCommand("/lsp restart");

		expect(notifications.showError).toHaveBeenCalledWith(
			"Failed to stop LSP servers: boom",
		);
		expect(notifications.showError).toHaveBeenCalledWith(
			"Restart aborted due to stop failure.",
		);
		expect(mocks.autostartLspServers).not.toHaveBeenCalled();
	});

	it("stops gracefully when disabled via stop subcommand", async () => {
		const { view, mocks, notifications } = await buildView({
			LSP_ENABLED: false,
		});

		await view.handleLspCommand("/lsp stop");

		expect(notifications.showError).toHaveBeenCalledWith(
			expect.stringContaining("LSP is disabled"),
		);
		expect(mocks.shutdownAll).not.toHaveBeenCalled();
	});
});
