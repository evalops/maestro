import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/mcp/index.js", () => ({
	mcpManager: new EventEmitter(),
}));

vi.mock("../../src/composers/index.js", () => ({
	composerManager: new EventEmitter(),
}));

import { createMcpEventsController } from "../../src/cli-tui/tui-renderer/mcp-events-setup.js";
import { composerManager } from "../../src/composers/index.js";
import { mcpManager } from "../../src/mcp/index.js";

function createNotificationView() {
	return {
		showToast: vi.fn(),
	} as const;
}

describe("createMcpEventsController", () => {
	beforeEach(() => {
		(mcpManager as EventEmitter).removeAllListeners();
		(composerManager as EventEmitter).removeAllListeners();
		vi.clearAllMocks();
	});

	it("shows a warning toast and refreshes the footer on MCP errors", () => {
		const notificationView = createNotificationView();
		const refreshFooterHint = vi.fn();
		const controller = createMcpEventsController({
			notificationView: notificationView as never,
			refreshFooterHint,
		});

		expect(() =>
			(mcpManager as EventEmitter).emit("error", {
				name: "remote",
				error: "Connection refused",
			}),
		).not.toThrow();

		expect(notificationView.showToast).toHaveBeenCalledWith(
			'MCP server "remote" error: Connection refused',
			"warn",
		);
		expect(refreshFooterHint).toHaveBeenCalledOnce();

		controller.stop();
	});

	it("falls back to a generic message for blank MCP errors", () => {
		const notificationView = createNotificationView();
		const controller = createMcpEventsController({
			notificationView: notificationView as never,
			refreshFooterHint: vi.fn(),
		});

		(mcpManager as EventEmitter).emit("error", {
			name: "remote",
			error: "   ",
		});

		expect(notificationView.showToast).toHaveBeenCalledWith(
			'MCP server "remote" error: Connection failed.',
			"warn",
		);

		controller.stop();
	});

	it("registers and removes the MCP error listener", () => {
		const controller = createMcpEventsController({
			notificationView: createNotificationView() as never,
			refreshFooterHint: vi.fn(),
		});

		expect((mcpManager as EventEmitter).listenerCount("error")).toBe(1);

		controller.stop();

		expect((mcpManager as EventEmitter).listenerCount("error")).toBe(0);
	});
});
