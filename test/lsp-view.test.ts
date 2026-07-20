import { Container, TUI } from "@evalops/tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createStubTerminal = (): import("@evalops/tui").Terminal => ({
	start: vi.fn(),
	stop: vi.fn(),
	write: vi.fn(),
	get columns() {
		return 80;
	},
	get rows() {
		return 24;
	},
	moveBy: vi.fn(),
	hideCursor: vi.fn(),
	showCursor: vi.fn(),
	clearLine: vi.fn(),
	clearFromCursor: vi.fn(),
	clearScreen: vi.fn(),
});

class StubTui extends TUI {
	override requestRender = vi.fn();
	override setFocus = vi.fn();
	override start = vi.fn();
	override stop = vi.fn();

	constructor() {
		super(createStubTerminal());
	}
}

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

	const { LspView } = await import("../src/cli-tui/lsp-view.js");

	const chatContainer = new Container();
	const ui = new StubTui();
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
