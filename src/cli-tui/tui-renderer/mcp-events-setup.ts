/**
 * MCP Events Setup - Event handlers for MCP server notifications
 *
 * This module sets up event listeners for MCP server lifecycle events:
 * - Server connections/disconnections
 * - Server errors
 * - Tool list changes (debounced)
 * - Progress notifications
 * - Log messages (warnings/errors only)
 */

import { composerManager } from "../../composers/index.js";
import { mcpManager } from "../../mcp/index.js";
import type { NotificationView } from "../notification-view.js";

export interface McpEventHandlers {
	connected?: (data: { name: string; tools: number }) => void;
	disconnected?: (data: { name: string }) => void;
	error?: (data: { name: string; error: string }) => void;
	toolsChanged?: (data: { name: string }) => void;
	progress?: (data: {
		name: string;
		progress: number;
		total?: number;
		message?: string;
	}) => void;
	log?: (data: { name: string; level: string; data: unknown }) => void;
	composerActivated?: (composer: { name: string }) => void;
	composerDeactivated?: (composer: { name: string }) => void;
}

export interface McpEventsController {
	/**
	 * Stop listening to MCP events and clean up handlers
	 */
	stop(): void;
}

export function createMcpEventsController(params: {
	notificationView: NotificationView;
	refreshFooterHint: () => void;
}): McpEventsController {
	const { notificationView, refreshFooterHint } = params;

	// Track timeout for debounced tools_changed notifications
	let toolsChangedTimeout: ReturnType<typeof setTimeout> | undefined;
	const pendingToolsChangedServers = new Set<string>();

	// Event handlers stored for cleanup
	const handlers: McpEventHandlers = {};

	// Connection handler
	handlers.connected = ({ name, tools }) => {
		notificationView.showToast(
			`MCP server "${name}" connected (${tools} tools)`,
			"success",
		);
		refreshFooterHint();
	};

	// Disconnection handler
	handlers.disconnected = ({ name }) => {
		notificationView.showToast(`MCP server "${name}" disconnected`, "warn");
		refreshFooterHint();
	};

	// Error handler
	handlers.error = ({ name, error }) => {
		const errorLabel = error.trim() || "Connection failed.";
		notificationView.showToast(
			`MCP server "${name}" error: ${errorLabel}`,
			"warn",
		);
		refreshFooterHint();
	};

	// Tools changed handler (debounced)
	handlers.toolsChanged = ({ name }) => {
		pendingToolsChangedServers.add(name);
		refreshFooterHint();
		if (toolsChangedTimeout) clearTimeout(toolsChangedTimeout);
		toolsChangedTimeout = setTimeout(() => {
			const servers = Array.from(pendingToolsChangedServers);
			pendingToolsChangedServers.clear();
			const msg =
				servers.length === 1
					? `MCP server "${servers[0]}" tools updated`
					: `MCP servers updated: ${servers.join(", ")}`;
			notificationView.showToast(msg, "info");
		}, 500);
	};

	// Progress handler
	handlers.progress = ({ name, progress, total, message }) => {
		let msg: string;
		if (total && total > 0) {
			// Determinate progress - show percentage
			const percent = Math.min(
				100,
				Math.max(0, Math.round((progress / total) * 100)),
			);
			msg = message
				? `${name}: ${message} (${percent}%)`
				: `${name}: ${percent}%`;
		} else {
			// Indeterminate progress - skip percentage, show message only
			msg = message ? `${name}: ${message}` : `${name}: in progress`;
		}
		notificationView.showToast(msg, "info");
	};

	// Log handler (warnings and errors only)
	handlers.log = ({ name, level, data }) => {
		if (level === "warning" || level === "error") {
			let msg: string;
			if (typeof data === "string") {
				msg = data;
			} else if (data === undefined || data === null) {
				msg = String(data);
			} else {
				try {
					msg = JSON.stringify(data);
				} catch {
					msg = "[Unserializable data]";
				}
			}
			// Use substring to avoid breaking multi-byte characters
			msg = msg.substring(0, 100);
			notificationView.showToast(
				`[${name}] ${msg}`,
				level === "error" ? "warn" : "info",
			);
		}
	};

	// Composer activation handlers
	handlers.composerActivated = (composer) => {
		notificationView.showToast(
			`Maestro "${composer.name}" activated`,
			"success",
		);
		refreshFooterHint();
	};

	handlers.composerDeactivated = (composer) => {
		notificationView.showToast(
			`Maestro "${composer.name}" deactivated`,
			"info",
		);
		refreshFooterHint();
	};

	// Register event handlers
	mcpManager.on("connected", handlers.connected);
	mcpManager.on("disconnected", handlers.disconnected);
	mcpManager.on("error", handlers.error);
	mcpManager.on("tools_changed", handlers.toolsChanged);
	mcpManager.on("progress", handlers.progress);
	mcpManager.on("log", handlers.log);
	composerManager.on("activated", handlers.composerActivated);
	composerManager.on("deactivated", handlers.composerDeactivated);

	return {
		stop() {
			// Clean up timeout
			if (toolsChangedTimeout) {
				clearTimeout(toolsChangedTimeout);
				toolsChangedTimeout = undefined;
			}

			// Remove event listeners
			if (handlers.connected) {
				mcpManager.off("connected", handlers.connected);
			}
			if (handlers.disconnected) {
				mcpManager.off("disconnected", handlers.disconnected);
			}
			if (handlers.error) {
				mcpManager.off("error", handlers.error);
			}
			if (handlers.toolsChanged) {
				mcpManager.off("tools_changed", handlers.toolsChanged);
			}
			if (handlers.progress) {
				mcpManager.off("progress", handlers.progress);
			}
			if (handlers.log) {
				mcpManager.off("log", handlers.log);
			}
			if (handlers.composerActivated) {
				composerManager.off("activated", handlers.composerActivated);
			}
			if (handlers.composerDeactivated) {
				composerManager.off("deactivated", handlers.composerDeactivated);
			}
		},
	};
}
