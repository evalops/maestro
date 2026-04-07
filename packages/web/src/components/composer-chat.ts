/**
 * Main chat interface component
 */

import type {
	ComposerActionApprovalRequest,
	ComposerApprovalMode,
	ComposerPendingClientToolRequest,
	ComposerToolRetryRequest,
} from "@evalops/contracts";
import { LitElement, type PropertyValues, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { parse as parsePartialJson } from "partial-json";
import {
	type AgentEvent,
	ApiClient,
	type ComposerToolCall,
	type McpPromptResponse,
	type McpResourceReadResponse,
	type McpServerStatus,
	type McpStatus,
	type Message,
	type Model,
	type Session,
	type SessionSummary,
	type UsageSummary,
	type WorkspaceStatus,
} from "../services/api-client.js";
import type { Artifact } from "../services/artifacts.js";
import {
	applyArtifactsCommand,
	coerceArtifactsArgs,
	createEmptyArtifactsState,
	reconstructArtifactsFromMessages,
} from "../services/artifacts.js";
import { dataStore } from "../services/data-store.js";
import { formatWebRuntimeStatus } from "../services/runtime-status.js";
import { summarizeWebToolCalls } from "../services/tool-summary.js";
import "./command-drawer.js";
import { executeWebSlashCommand } from "./composer-chat-slash-commands.js";
import {
	WEB_SLASH_COMMANDS,
	type WebSlashCommand,
	buildWebSlashCommands,
} from "./slash-commands.js";
import "./composer-message.js";
import "./composer-input.js";
import type { ComposerInput } from "./composer-input.js";
import "./composer-session-sidebar.js";
import "./composer-share-dialog.js";
import "./composer-export-dialog.js";
import "./composer-settings.js";
import "./composer-approval.js";
import "./composer-mcp-elicitation.js";
import "./composer-tool-retry.js";
import "./composer-user-input.js";
import "./model-selector.js";
import "./admin-settings.js";
import "./composer-artifacts-panel.js";
import "./composer-attachment-viewer.js";
import { ArtifactsRuntimeProvider } from "./sandbox/artifacts-runtime-provider.js";
import { AttachmentsRuntimeProvider } from "./sandbox/attachments-runtime-provider.js";
import { getSandboxConsoleSnapshot } from "./sandbox/console-runtime-provider.js";
import { getSandboxDownloadsSnapshot } from "./sandbox/file-download-runtime-provider.js";
import { FileDownloadRuntimeProvider } from "./sandbox/file-download-runtime-provider.js";
import { JavascriptReplRuntimeProvider } from "./sandbox/javascript-repl-runtime-provider.js";

const STATUS_CACHE_KEY = "composer_status_cache";
const MODELS_CACHE_KEY = "composer_models_cache";
const USAGE_CACHE_KEY = "composer_usage_cache";
const MODEL_OVERRIDE_KEY = "composer_model_override";
const THEME_KEY = "composer_theme";
const TRANSPORT_KEY = "composer_transport";

const parseToolCallArgs = (
	raw: string,
): Record<string, unknown> | undefined => {
	if (!raw || raw.trim() === "") return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		try {
			const parsed = parsePartialJson(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// ignore partial parse errors during streaming
		}
		return undefined;
	}
};

interface ExtendedToolCall extends ComposerToolCall {
	startTime?: number;
	endTime?: number;
	argsTruncated?: boolean;
	displayName?: string;
	summaryLabel?: string;
}

interface ActiveToolInfo {
	name: string;
	args: unknown;
	index: number;
	argsTruncated?: boolean;
}

/** Extended message type with thinking support for streaming */
interface MessageWithThinking extends Message {
	thinking?: string;
}

type UiMessage = Omit<Message, "tools"> & {
	tools?: ExtendedToolCall[];
	localOnly?: boolean;
};

type AssistantMessageSnapshot = Pick<Message, "content"> & {
	tools?: unknown[];
	thinking?: string;
};

function getMessageTextContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item?.type === "text" ? item.text : ""))
		.join("");
}

export function hasAssistantMessageProgress(
	message: AssistantMessageSnapshot,
): boolean {
	if (getMessageTextContent(message.content).trim().length > 0) {
		return true;
	}
	if (
		typeof message.thinking === "string" &&
		message.thinking.trim().length > 0
	) {
		return true;
	}
	return Array.isArray(message.tools) && message.tools.length > 0;
}

function coerceToolArgsRecord(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	return args as Record<string, unknown>;
}

function isUserInputRequest(
	request: Pick<ComposerPendingClientToolRequest, "kind" | "toolName">,
): boolean {
	return request.kind === "user_input" || request.toolName === "ask_user";
}

function isMcpElicitationRequest(
	request: Pick<ComposerPendingClientToolRequest, "kind" | "toolName">,
): boolean {
	return (
		request.kind === "mcp_elicitation" || request.toolName === "mcp_elicitation"
	);
}

function getOptionalStringArg(
	args: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getMcpToolCount(server: McpServerStatus): number {
	if (Array.isArray(server.tools)) {
		return server.tools.length;
	}
	return typeof server.tools === "number" ? server.tools : 0;
}

function formatMcpServers(status: McpStatus): string {
	if (status.servers.length === 0) {
		return "No MCP servers configured.";
	}

	const lines: string[] = ["# MCP Servers", ""];
	for (const server of status.servers) {
		lines.push(
			`- ${server.name}: ${server.connected ? "connected" : "disconnected"}`,
		);
		if (server.transport) {
			lines.push(`  transport: ${server.transport}`);
		}
		if (server.remoteUrl) {
			lines.push(`  remote: ${server.remoteUrl}`);
		}
		if (server.remoteTrust) {
			lines.push(`  trust: ${server.remoteTrust}`);
		}
		if (server.officialRegistry?.displayName) {
			lines.push(`  official: ${server.officialRegistry.displayName}`);
		}
		if (server.scope) {
			lines.push(`  scope: ${server.scope}`);
		}
		lines.push(`  tools: ${getMcpToolCount(server)}`);
		lines.push(`  resources: ${server.resources?.length ?? 0}`);
		lines.push(`  prompts: ${server.prompts?.length ?? 0}`);
		if (server.officialRegistry?.documentationUrl) {
			lines.push(`  docs: ${server.officialRegistry.documentationUrl}`);
		}
		if (server.officialRegistry?.permissions) {
			lines.push(`  permissions: ${server.officialRegistry.permissions}`);
		}
		if (server.error) {
			lines.push(`  error: ${server.error}`);
		}
	}
	return lines.join("\n");
}

function formatMcpTools(
	status: McpStatus,
	serverName?: string,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return { isError: true, text: `MCP server '${serverName}' not found.` };
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithTools = servers
		.filter((server) => server.connected)
		.map((server) => ({
			name: server.name,
			tools: Array.isArray(server.tools) ? server.tools : [],
		}))
		.filter((server) => server.tools.length > 0);

	if (connectedWithTools.length === 0) {
		return {
			isError: false,
			text: "No MCP tools available. Either no servers are connected or they don't expose tools.",
		};
	}

	const lines: string[] = ["# Available MCP Tools", ""];
	for (const server of connectedWithTools) {
		lines.push(`## ${server.name}`);
		for (const tool of server.tools) {
			lines.push(
				tool.description
					? `- ${tool.name}: ${tool.description}`
					: `- ${tool.name}`,
			);
		}
		lines.push("");
	}

	return { isError: false, text: lines.join("\n").trimEnd() };
}

function formatMcpResources(
	status: McpStatus,
	serverName: string | undefined,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return {
			isError: true,
			text: `MCP server '${serverName}' not found.`,
		};
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithResources = servers
		.filter((server) => server.connected)
		.filter((server) => (server.resources?.length ?? 0) > 0);

	if (connectedWithResources.length === 0) {
		return {
			isError: false,
			text: "No MCP resources available. Either no servers are connected or they don't expose resources.",
		};
	}

	const lines: string[] = ["# Available MCP Resources", ""];
	for (const server of connectedWithResources) {
		lines.push(`## ${server.name}`);
		for (const uri of server.resources ?? []) {
			lines.push(`- ${uri}`);
		}
		lines.push("");
	}
	return { isError: false, text: lines.join("\n").trimEnd() };
}

function formatMcpResourceRead(
	result: McpResourceReadResponse,
	uri: string,
): string {
	if (result.contents.length === 0) {
		return `Resource '${uri}' is empty.`;
	}

	const textContents = result.contents
		.filter((content) => typeof content.text === "string")
		.map((content) => content.text as string);

	if (textContents.length > 0) {
		return textContents.join("\n---\n");
	}

	return JSON.stringify(result.contents, null, 2);
}

function formatMcpPrompts(
	status: McpStatus,
	serverName?: string,
): { isError: boolean; text: string } {
	const servers = serverName
		? status.servers.filter((server) => server.name === serverName)
		: status.servers;

	if (serverName && servers.length === 0) {
		return { isError: true, text: `MCP server '${serverName}' not found.` };
	}

	const disconnected = serverName
		? servers.find((server) => !server.connected)
		: null;
	if (disconnected) {
		return {
			isError: true,
			text: `MCP server '${disconnected.name}' is not connected.`,
		};
	}

	const connectedWithPrompts = servers
		.filter((server) => server.connected)
		.filter((server) => (server.prompts?.length ?? 0) > 0);

	if (connectedWithPrompts.length === 0) {
		return {
			isError: false,
			text: serverName
				? `MCP server '${serverName}' does not expose prompts.`
				: "No MCP prompts available. Either no servers are connected or they don't expose prompts.",
		};
	}

	const lines: string[] = ["# Available MCP Prompts", ""];
	for (const server of connectedWithPrompts) {
		lines.push(`## ${server.name}`);
		for (const promptName of server.prompts ?? []) {
			lines.push(`- ${promptName}`);
			const prompt = server.promptDetails?.find(
				(entry) => entry.name === promptName,
			);
			const promptArguments = prompt?.arguments ?? [];
			if (prompt?.title && prompt.title !== promptName) {
				lines.push(`  Title: ${prompt.title}`);
			}
			if (prompt?.description) {
				lines.push(`  Description: ${prompt.description}`);
			}
			if (promptArguments.length > 0) {
				lines.push(
					`  Args: ${promptArguments
						.map((argument) => {
							const summary = argument.required
								? `${argument.name} (required)`
								: argument.name;
							return argument.description
								? `${summary}: ${argument.description}`
								: summary;
						})
						.join("; ")}`,
				);
			}
		}
		lines.push("");
	}

	return { isError: false, text: lines.join("\n").trimEnd() };
}

function formatMcpPrompt(
	result: McpPromptResponse,
	promptName: string,
): string {
	const lines: string[] = [`Prompt: ${promptName}`, ""];
	if (result.description) {
		lines.push(`Description: ${result.description}`, "");
	}
	for (const message of result.messages) {
		lines.push(`[${message.role}]`);
		lines.push(message.content);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export function getTerminalStreamOutcome(
	event: AgentEvent,
): { message: string; type: "error" | "info" } | null {
	switch (event.type) {
		case "error":
			return {
				message: event.message?.trim() || "Failed to complete request",
				type: "error",
			};
		case "aborted":
			return { message: "Request aborted", type: "info" };
		case "agent_end":
			return event.aborted
				? { message: "Request aborted", type: "info" }
				: null;
		default:
			return null;
	}
}

@customElement("composer-chat")
export class ComposerChat extends LitElement {
	static override styles = css`
		:host {
			display: flex !important;
			height: 100% !important;
			width: 100% !important;
			background: var(--bg-primary, #0c0d0f);
			color: var(--text-primary, #e8e9eb);
			overflow: hidden;
			font-family: var(--font-mono, "JetBrains Mono", monospace);
		}

		/* Main Content */
		.main-content {
			flex: 1;
			display: flex;
			flex-direction: column;
			position: relative;
			min-width: 0;
			background: var(--bg-primary, #0c0d0f);
		}

		:host([zen]) composer-session-sidebar {
			display: none;
		}

		:host([zen]) .header {
			display: none;
		}

		:host([zen]) .messages {
			padding-top: 2.5rem;
		}

		.header {
			display: grid;
			grid-template-columns: auto 1fr auto;
			align-items: center;
			gap: 1rem;
			padding: 0.625rem 1.25rem;
			background: var(--bg-deep, #08090a);
			border-bottom: 1px solid var(--border-primary, #1e2023);
			min-height: 48px;
			z-index: 10;
		}

		.header-left {
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.toggle-sidebar-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.toggle-sidebar-btn:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--border-hover, #3a3d42);
		}

		.header h1 {
			font-family: var(--font-display, "DM Sans", sans-serif);
			font-size: 0.9rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary, #e8e9eb);
			letter-spacing: -0.01em;
		}

		.status-bar {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: nowrap;
			white-space: nowrap;
			overflow-x: auto;
			min-width: 0;
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
		}

		.status-item {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.2rem 0.5rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-size: 0.6rem;
			font-weight: 500;
			transition: all 0.15s ease;
		}

		.status-item:hover {
			border-color: var(--border-hover, #3a3d42);
		}

		.status-item.active {
			border-color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
		}

		.header-right {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: nowrap;
			white-space: nowrap;
		}

		.pill {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			color: var(--text-secondary, #8b8d91);
			font-weight: 600;
			font-size: 0.6rem;
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}

		.pill.warning {
			background: var(--accent-yellow-dim, rgba(234, 179, 8, 0.12));
			color: var(--accent-yellow, #eab308);
		}

		.pill.success {
			background: var(--accent-green-dim, rgba(34, 197, 94, 0.12));
			color: var(--accent-green, #22c55e);
		}

		.pill.error {
			background: var(--accent-red-dim, rgba(239, 68, 68, 0.12));
			color: var(--accent-red, #ef4444);
		}

		.pill.info {
			background: rgba(20, 184, 166, 0.12);
			color: var(--accent, #14b8a6);
		}

		.status-note {
			color: var(--accent-yellow, #eab308);
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}

		.status-item.runtime-status {
			border-color: rgba(20, 184, 166, 0.18);
			background: rgba(20, 184, 166, 0.04);
		}

		.status-dot {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-green, #22c55e);
			box-shadow: 0 0 6px var(--accent-green, #22c55e);
		}

		.status-dot.offline {
			background: var(--accent-red, #ef4444);
			box-shadow: none;
		}

		/* Messages Area */
		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem 2rem;
			display: flex;
			flex-direction: column;
			background: var(--bg-primary, #0c0d0f);
			scroll-behavior: smooth;
		}

		.messages.compact {
			padding: 1rem;
		}

		.virtual-spacer {
			width: 100%;
			display: block;
		}

		.history-truncation {
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-elevated, #161719);
			padding: 0.5rem 0.75rem;
			margin-bottom: 0.75rem;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.history-btn {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 26px;
			padding: 0 0.6rem;
			cursor: pointer;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.history-btn:hover {
			background: var(--bg-surface, #1a1b1e);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--accent-amber, #d4a012);
		}

		.history-btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
		}

		.jump-latest {
			position: sticky;
			bottom: 0.75rem;
			align-self: center;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.12));
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			padding: 0.5rem 0.8rem;
			cursor: pointer;
			letter-spacing: 0.02em;
			backdrop-filter: blur(8px);
			z-index: 5;
		}

		.jump-latest:hover {
			border-color: var(--accent-blue, #3b82f6);
			background: var(--accent-blue-dim, rgba(59, 130, 246, 0.18));
		}

		.input-container {
			padding: 1rem 1.5rem 1.5rem;
			background: var(--bg-deep, #08090a);
			border-top: 1px solid var(--border-primary, #1e2023);
			position: sticky;
			bottom: 0;
			z-index: 15;
		}

		/* Model Selector */
		.model-selector {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.25rem 0.6rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			color: var(--text-secondary, #8b8d91);
			font-weight: 500;
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.model-selector:hover {
			background: var(--bg-surface, #1a1b1e);
			border-color: var(--border-hover, #3a3d42);
			color: var(--text-primary, #e8e9eb);
		}

		.model-badge {
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: var(--accent-amber, #d4a012);
		}

		/* Icon Buttons */
		.icon-btn {
			width: 26px;
			height: 26px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			cursor: pointer;
			transition: all 0.15s ease;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.icon-btn:hover {
			background: var(--bg-elevated, #161719);
			border-color: var(--border-hover, #3a3d42);
			color: var(--text-primary, #e8e9eb);
		}

		.icon-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.icon-btn:disabled:hover {
			background: transparent;
			border-color: var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
		}

		.icon-btn.active {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
		}

		.icon {
			width: 14px;
			height: 14px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.5;
			stroke-linecap: round;
			stroke-linejoin: round;
			pointer-events: none;
		}

		/* Toast */
		.toast {
			position: fixed;
			bottom: 20px;
			right: 20px;
			padding: 0.6rem 1rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
			z-index: 300;
			display: flex;
			align-items: center;
			gap: 0.75rem;
			animation: slideIn 0.2s ease;
		}

		@keyframes slideIn {
			from { opacity: 0; transform: translateX(10px); }
			to { opacity: 1; transform: translateX(0); }
		}

		.toast.success { border-left: 2px solid var(--accent-green, #22c55e); }
		.toast.error { border-left: 2px solid var(--accent-red, #ef4444); }
		.toast.info { border-left: 2px solid var(--accent-amber, #d4a012); }

		.side-panel {
			position: absolute;
			top: 0;
			right: 0;
			height: 100%;
			background: var(--bg-primary, #0a0e14);
			border-left: 2px solid var(--border-primary, #21262d);
			z-index: 100;
		}

		.side-panel.settings {
			width: min(500px, 92vw);
		}

		.side-panel.admin {
			width: min(800px, 95vw);
			z-index: 110;
		}

		.health-popover {
			position: fixed;
			top: 64px;
			right: 12px;
			width: 260px;
			background: var(--bg-secondary, #0d1117);
			border: 1px solid var(--border-secondary, #30363d);
			padding: 0.75rem;
			z-index: 120;
			box-shadow: var(--shadow-md, 0 10px 24px rgba(0, 0, 0, 0.4));
			font-family: var(--font-mono, "SF Mono", "Menlo", "Monaco", monospace);
			font-size: 0.75rem;
			color: var(--text-primary, #e6edf3);
		}

		.health-popover-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 0.5rem;
		}

		.health-popover-label {
			color: var(--text-tertiary, #6e7681);
			letter-spacing: 0.05em;
		}

		.health-popover-row {
			margin: 0.25rem 0;
		}

		.health-popover-row span {
			color: var(--text-tertiary, #6e7681);
		}

		.shortcuts-modal {
			position: fixed;
			top: 30%;
			left: 50%;
			transform: translateX(-50%);
			width: min(420px, 90vw);
			background: var(--bg-secondary, #0d1117);
			border: 1px solid var(--border-secondary, #30363d);
			padding: 1rem;
			z-index: 140;
			box-shadow: var(--shadow-lg, 0 18px 40px rgba(0, 0, 0, 0.5));
			font-family: var(--font-mono, "SF Mono", "Menlo", "Monaco", monospace);
			font-size: 0.78rem;
			color: var(--text-primary, #e6edf3);
		}

		.shortcuts-modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 0.75rem;
		}

		.shortcuts-modal-title {
			letter-spacing: 0.08em;
			color: var(--text-tertiary, #8b949e);
		}

		.shortcuts-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.35rem 0.75rem;
		}

		/* Empty State */
		.empty-state {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			padding: 2rem;
			background: var(--bg-primary, #0c0d0f);
		}

		.workspace-panel {
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 1rem;
			background: transparent;
			border: none;
			margin: 2rem 0;
			width: 100%;
			max-width: 800px;
		}

		.panel-section {
			background: var(--bg-elevated, #161719);
			padding: 1rem;
			border: 1px solid var(--border-primary, #1e2023);
		}

		.panel-section h3 {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--text-tertiary, #5c5e62);
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin: 0 0 0.75rem 0;
		}

		.panel-item {
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			color: var(--text-primary, #e8e9eb);
			margin: 0.4rem 0;
			display: flex;
			align-items: center;
		}

		.panel-item span {
			color: var(--text-tertiary, #5c5e62);
			margin-right: 0.5rem;
			min-width: 2.5rem;
		}

		.session-gallery {
			margin-top: 1.5rem;
			width: 100%;
			max-width: 800px;
			background: transparent;
			border: none;
			box-shadow: none;
			padding: 0;
		}

		.session-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
			gap: 0.75rem;
		}

		.session-card {
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			padding: 1rem;
			text-align: left;
			cursor: pointer;
			transition: all 0.15s ease;
			color: var(--text-primary, #e8e9eb);
		}

		.session-card:hover {
			border-color: var(--accent-amber, #d4a012);
			background: var(--bg-surface, #1a1b1e);
		}

		.session-card-title {
			font-family: var(--font-mono, monospace);
			font-size: 0.8rem;
			font-weight: 500;
			margin-bottom: 0.35rem;
		}

		/* Responsive */
		@media (max-width: 768px) {
			.workspace-panel {
				grid-template-columns: 1fr;
			}
		}

		.sidebar-overlay {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.4);
			z-index: 15;
			display: none;
		}

		@media (max-width: 960px) {
			.header {
				grid-template-columns: 1fr;
				gap: 0.5rem;
				padding: 0.6rem 0.85rem;
			}
			.status-bar {
				flex-wrap: wrap;
				row-gap: 0.4rem;
				justify-content: flex-start;
			}
			.header-right {
				flex-wrap: wrap;
				justify-content: flex-start;
				gap: 0.35rem;
			}
			.messages {
				padding: 1.1rem 1.25rem;
			}
		}

		@media (max-width: 640px) {
			.header {
				padding: 0.55rem 0.75rem;
			}
			.header h1 {
				font-size: 0.9rem;
			}
			.status-bar {
				display: none;
			}
			.messages {
				padding: 0.9rem 0.9rem;
			}
		}

		@media (max-width: 768px) {
			.sidebar-overlay.active {
				display: block;
			}
		}
	`;

	@property() apiEndpoint = "";
	@property() model = "claude-sonnet-4-5";

	@state() private messages: UiMessage[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private runtimeStatus: string | null = null;
	@state() private currentModel = "";
	@state() private theme: "dark" | "light" = "dark";
	@state() private transportPreference: "auto" | "sse" | "ws" = "auto";
	@state() private sidebarOpen = true;
	@state() private sessions: SessionSummary[] = [];
	@state() private currentSessionId: string | null = null;
	@state() private shareToken: string | null = null;
	@state() private renderLimit = 200;
	@state() private renderEndIndex = 0;
	@state() private virtualStartIndex = 0;
	@state() private virtualEndIndex = 0;
	@state() private virtualPaddingTop = 0;
	@state() private virtualPaddingBottom = 0;
	@state()
	private avgMessageHeight = ComposerChat.DEFAULT_AVG_MESSAGE_HEIGHT;
	@state() private unseenMessages = 0;
	@state() private loadingEarlier = false;
	@state() private settingsOpen = false;
	@state() private adminSettingsOpen = false;
	@state() private artifactsOpen = false;
	@state() private activeArtifact: string | null = null;
	@state() private artifactsState = createEmptyArtifactsState();
	@state() private artifactsPanelAttachments: NonNullable<
		Message["attachments"]
	> = [];
	@state() private status: WorkspaceStatus | null = null;
	@state() private commandPrefs: { favorites: string[]; recents: string[] } = {
		favorites: [],
		recents: [],
	};
	@state() private slashCommands: WebSlashCommand[] = WEB_SLASH_COMMANDS;
	@state() private commandDrawerOpen = false;
	@state() private showModelSelector = false;
	@state() private currentModelTokens: string | null = null;
	@state() private models: Model[] = [];
	@state() private usage: UsageSummary | null = null;
	@state() private cleanMode: "off" | "soft" | "aggressive" = "off";
	@state() private footerMode: "ensemble" | "solo" = "ensemble";
	@state() private zenMode = false;
	@state() private queueMode: "one" | "all" = "all";
	@state() private shareDialogOpen = false;
	@state() private exportDialogOpen = false;
	@state() private toast: {
		message: string;
		type: "info" | "error" | "success";
	} | null = null;
	@state() private clientOnline =
		typeof navigator !== "undefined" ? navigator.onLine : true;
	@state() private lastSendFailed: string | null = null;
	@state() private lastApiError: string | null = null;
	@state() private pendingApprovalQueue: ComposerActionApprovalRequest[] = [];
	@state() private approvalSubmitting = false;
	@state() private pendingToolRetryQueue: ComposerToolRetryRequest[] = [];
	@state() private toolRetrySubmitting = false;
	@state()
	private pendingMcpElicitationQueue: ComposerPendingClientToolRequest[] = [];
	@state() private mcpElicitationSubmitting = false;
	@state()
	private pendingUserInputQueue: ComposerPendingClientToolRequest[] = [];
	@state() private userInputSubmitting = false;
	@state() private approvalMode: ComposerApprovalMode | null = null;
	@state() private approvalModeNotice: string | null = null;
	@state() private nextRefreshAllowed = 0;
	@state() private showHealth = false;
	@state() private showShortcuts = false;
	@state() private attachmentViewerOpen = false;
	@state() private attachmentViewerAttachment:
		| NonNullable<Message["attachments"]>[number]
		| null = null;
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	private reducedMotion = false;
	@property({ type: Boolean }) private compactMode = false;

	private static COMPACT_KEY = "composer_compact_mode";
	private static REDUCED_MOTION_KEY = "composer_reduced_motion";

	private apiClient!: ApiClient;
	private approvalModeNoticeSessionId: string | null = null;
	private approvalModeRequestId = 0;
	private artifactsPanelAttachmentsRequestId = 0;
	private attachmentContentCache = new Map<string, string>();
	private unsubscribeStore?: () => void;
	private autoScroll = true;
	private lastMessagesLength = 0;
	private messagesScrollRaf: number | null = null;
	private messageHeights = new Map<number, number>();
	private observedMessageNodes = new Set<Element>();
	private messageResizeObserver: ResizeObserver | null = null;
	private static DEFAULT_AVG_MESSAGE_HEIGHT = 120;
	private static VIRTUALIZATION_MIN_MESSAGES = 120;
	private static VIRTUAL_OVERSCAN = 6;

	private resetVirtualizationState(): void {
		this.messageHeights.clear();
		this.avgMessageHeight = ComposerChat.DEFAULT_AVG_MESSAGE_HEIGHT;
		this.virtualStartIndex = 0;
		this.virtualEndIndex = 0;
		this.virtualPaddingTop = 0;
		this.virtualPaddingBottom = 0;
	}
	private historyObserver: IntersectionObserver | null = null;
	private observedHistoryEl: Element | null = null;
	private handleOnline = () => {
		this.clientOnline = true;
		this.refreshStatus();
	};
	private handleOffline = () => {
		this.clientOnline = false;
	};
	private toggleHealth() {
		this.showHealth = !this.showHealth;
	}
	private closeHealth() {
		this.showHealth = false;
	}
	private handleKeydown = (e: KeyboardEvent) => {
		if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.toggleShortcuts();
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
			e.preventDefault();
			this.toggleCompact();
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			this.commandDrawerOpen = true;
		}
	};
	private toggleShortcuts() {
		this.showShortcuts = !this.showShortcuts;
	}
	private closeShortcuts() {
		this.showShortcuts = false;
	}

	private handleVoiceError = (event: CustomEvent<{ message?: string }>) => {
		const message =
			event.detail?.message || "Voice input failed. Check microphone settings.";
		this.showToast(message, "error", 2400);
	};

	private getMessagesScroller(): HTMLElement | null {
		return (
			(this.shadowRoot?.querySelector(".messages") as HTMLElement | null) ??
			null
		);
	}

	private getRenderEnd(): number {
		const total = this.messages.length;
		if (this.renderEndIndex > 0 && this.renderEndIndex <= total)
			return this.renderEndIndex;
		return total;
	}

	private getRenderWindow(): { start: number; end: number; total: number } {
		const total = this.messages.length;
		const end = this.getRenderEnd();
		const windowSize = Math.max(1, this.renderLimit);
		const start = Math.max(0, end - windowSize);
		return { start, end, total };
	}

	private estimateMessageHeight(index: number): number {
		return this.messageHeights.get(index) ?? this.avgMessageHeight;
	}

	private updateVirtualWindow(): void {
		const scroller = this.getMessagesScroller();
		const { start, end } = this.getRenderWindow();
		const totalVisible = Math.max(0, end - start);

		if (!scroller || totalVisible === 0) {
			this.virtualStartIndex = start;
			this.virtualEndIndex = end;
			this.virtualPaddingTop = 0;
			this.virtualPaddingBottom = 0;
			return;
		}

		const shouldVirtualize =
			totalVisible >= ComposerChat.VIRTUALIZATION_MIN_MESSAGES;
		if (!shouldVirtualize) {
			if (
				this.virtualStartIndex !== start ||
				this.virtualEndIndex !== end ||
				this.virtualPaddingTop !== 0 ||
				this.virtualPaddingBottom !== 0
			) {
				this.virtualStartIndex = start;
				this.virtualEndIndex = end;
				this.virtualPaddingTop = 0;
				this.virtualPaddingBottom = 0;
			}
			return;
		}

		const heights: number[] = [];
		let totalHeight = 0;
		for (let i = 0; i < totalVisible; i += 1) {
			const h = this.estimateMessageHeight(start + i);
			heights.push(h);
			totalHeight += h;
		}

		const overscanPx = this.avgMessageHeight * ComposerChat.VIRTUAL_OVERSCAN;
		const targetStart = Math.max(0, scroller.scrollTop - overscanPx);
		const targetEnd = scroller.scrollTop + scroller.clientHeight + overscanPx;

		let topPadding = 0;
		let localStart = 0;
		for (; localStart < totalVisible; localStart += 1) {
			const h = heights[localStart];
			if (h === undefined) break;
			const next = topPadding + h;
			if (next >= targetStart) break;
			topPadding = next;
		}
		if (localStart >= totalVisible) {
			const lastIndex = Math.max(0, totalVisible - 1);
			localStart = lastIndex;
			topPadding = Math.max(0, totalHeight - (heights[lastIndex] ?? 0));
		}

		let visibleHeight = topPadding;
		let localEnd = localStart;
		for (; localEnd < totalVisible; localEnd += 1) {
			const h = heights[localEnd];
			if (h === undefined) break;
			visibleHeight += h;
			if (visibleHeight >= targetEnd) break;
		}
		if (localEnd === localStart) {
			localEnd = Math.min(totalVisible, localStart + 1);
			visibleHeight = topPadding + (heights[localStart] ?? 0);
		} else {
			localEnd += 1;
		}

		const bottomPadding = Math.max(0, totalHeight - visibleHeight);
		const nextStart = start + localStart;
		const nextEnd = start + localEnd;

		if (
			nextStart !== this.virtualStartIndex ||
			nextEnd !== this.virtualEndIndex ||
			topPadding !== this.virtualPaddingTop ||
			bottomPadding !== this.virtualPaddingBottom
		) {
			this.virtualStartIndex = nextStart;
			this.virtualEndIndex = nextEnd;
			this.virtualPaddingTop = Math.max(0, Math.round(topPadding));
			this.virtualPaddingBottom = Math.max(0, Math.round(bottomPadding));
		}
	}

	private ensureMessageObserver(): void {
		if (typeof ResizeObserver === "undefined") return;
		if (this.messageResizeObserver) return;
		this.messageResizeObserver = new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const node = entry.target as HTMLElement;
				const indexAttr = node.dataset.index;
				if (!indexAttr) continue;
				const index = Number.parseInt(indexAttr, 10);
				if (Number.isNaN(index)) continue;
				const height = Math.round(entry.contentRect.height);
				if (height <= 0) continue;
				const prev = this.messageHeights.get(index);
				if (prev !== height) {
					this.messageHeights.set(index, height);
					changed = true;
					const blended = Math.round(
						this.avgMessageHeight * 0.8 + height * 0.2,
					);
					if (Math.abs(blended - this.avgMessageHeight) > 1) {
						this.avgMessageHeight = blended;
					}
				}
			}
			if (changed) {
				this.updateVirtualWindow();
			}
		});
	}

	private syncMessageObservers(): void {
		this.ensureMessageObserver();
		if (!this.messageResizeObserver) return;

		const nodes = this.shadowRoot?.querySelectorAll<HTMLElement>(
			"composer-message[data-index]",
		);
		const nextNodes = new Set<Element>();
		if (nodes) {
			for (const node of Array.from(nodes)) {
				nextNodes.add(node);
				if (!this.observedMessageNodes.has(node)) {
					this.messageResizeObserver?.observe(node);
				}
			}
		}

		for (const node of this.observedMessageNodes) {
			if (!nextNodes.has(node)) {
				this.messageResizeObserver?.unobserve(node);
			}
		}

		this.observedMessageNodes = nextNodes;
	}

	private captureMessageHeights(): void {
		const nodes = this.shadowRoot?.querySelectorAll<HTMLElement>(
			"composer-message[data-index]",
		);
		if (!nodes || nodes.length === 0) return;

		let total = 0;
		let count = 0;
		let changed = false;
		for (const node of Array.from(nodes)) {
			const indexAttr = node.dataset.index;
			if (!indexAttr) continue;
			const index = Number.parseInt(indexAttr, 10);
			if (Number.isNaN(index)) continue;
			const height = node.offsetHeight;
			if (height <= 0) continue;
			const prev = this.messageHeights.get(index);
			if (prev !== height) {
				this.messageHeights.set(index, height);
				changed = true;
			}
			total += height;
			count += 1;
		}

		if (count > 0) {
			const nextAvg = Math.round(total / count);
			if (Math.abs(nextAvg - this.avgMessageHeight) > 2) {
				this.avgMessageHeight = nextAvg;
				changed = true;
			}
		}

		if (changed) {
			this.updateVirtualWindow();
		}
	}

	private syncRenderWindowToBottom() {
		this.autoScroll = true;
		this.unseenMessages = 0;
		this.renderEndIndex = this.messages.length;
		this.lastMessagesLength = this.messages.length;
	}

	private ensureHistoryObserver() {
		if (typeof window === "undefined") return;
		if (!("IntersectionObserver" in window)) return;
		if (this.historyObserver) return;

		const scroller = this.getMessagesScroller();
		if (!scroller) return;

		this.historyObserver = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					void this.maybeAutoLoadEarlier();
				}
			},
			{ root: scroller, threshold: 0.01 },
		);
	}

	private refreshHistoryObserverTarget() {
		if (!this.historyObserver) return;
		const next =
			this.shadowRoot?.querySelector("[data-history-truncation]") ?? null;
		if (next === this.observedHistoryEl) return;

		if (this.observedHistoryEl) {
			try {
				this.historyObserver.unobserve(this.observedHistoryEl);
			} catch {
				// ignore
			}
		}

		this.observedHistoryEl = next;
		if (next) {
			this.historyObserver.observe(next);
		}
	}

	private handleMessagesScroll = () => {
		if (this.messagesScrollRaf !== null) return;
		const raf = window.requestAnimationFrame
			? window.requestAnimationFrame.bind(window)
			: (cb: FrameRequestCallback) =>
					window.setTimeout(() => cb(Date.now()), 16);
		this.messagesScrollRaf = raf(() => {
			this.messagesScrollRaf = null;
			const scroller = this.getMessagesScroller();
			if (!scroller) return;

			const remaining =
				scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			const nearBottom = remaining < 64;

			if (nearBottom) {
				if (!this.autoScroll) {
					this.autoScroll = true;
					if (this.unseenMessages !== 0) this.unseenMessages = 0;
					const total = this.messages.length;
					if (this.renderEndIndex !== total) this.renderEndIndex = total;
					this.scrollToBottom({ force: true });
				} else if (this.unseenMessages !== 0) {
					this.unseenMessages = 0;
				}
			} else if (this.autoScroll) {
				this.autoScroll = false;
			}

			if (scroller.scrollTop < 80) {
				void this.maybeAutoLoadEarlier();
			}

			this.updateVirtualWindow();
		});
	};

	private async maybeAutoLoadEarlier() {
		const scroller = this.getMessagesScroller();
		if (!scroller) return;
		if (this.loadingEarlier) return;
		if (scroller.scrollTop > 120) return;

		const { start } = this.getRenderWindow();
		if (start <= 0) return;

		await this.loadEarlierMessages();
	}

	private jumpToLatest = () => {
		this.syncRenderWindowToBottom();
		this.scrollToBottom({ force: true });
	};

	private async loadEarlierMessages() {
		if (this.loadingEarlier) return;
		const { start, end } = this.getRenderWindow();
		if (start <= 0) return;

		this.loadingEarlier = true;
		const messagesEl = this.shadowRoot?.querySelector(
			".messages",
		) as HTMLElement | null;
		const prevScrollHeight = messagesEl?.scrollHeight ?? 0;
		const prevScrollTop = messagesEl?.scrollTop ?? 0;

		try {
			this.renderLimit = Math.min(end, this.renderLimit + 200);
			await this.updateComplete;

			if (!messagesEl) return;
			const nextScrollHeight = messagesEl.scrollHeight;
			const delta = Math.max(0, nextScrollHeight - prevScrollHeight);
			messagesEl.scrollTop = prevScrollTop + delta;
		} finally {
			this.loadingEarlier = false;
		}
	}

	private handleOpenAttachment = (
		e: CustomEvent<{
			attachment?: NonNullable<Message["attachments"]>[number];
		}>,
	) => {
		const attachment = e.detail?.attachment ?? null;
		if (!attachment) return;
		this.attachmentViewerAttachment = attachment;
		this.attachmentViewerOpen = true;
	};

	private closeAttachmentViewer = () => {
		this.attachmentViewerOpen = false;
		this.attachmentViewerAttachment = null;
	};

	private handleAttachmentUpdated = (
		e: CustomEvent<{ attachmentId?: unknown; extractedText?: unknown }>,
	) => {
		const attachmentId = e.detail?.attachmentId;
		const extractedText = e.detail?.extractedText;
		if (typeof attachmentId !== "string" || attachmentId.length === 0) return;
		if (typeof extractedText !== "string" || extractedText.length === 0) return;

		this.messages = this.messages.map((msg) => {
			const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
			if (atts.length === 0) return msg;
			const nextAtts = atts.map((a) =>
				a?.id === attachmentId ? { ...a, extractedText } : a,
			);
			return { ...msg, attachments: nextAtts };
		});

		if (this.attachmentViewerAttachment?.id === attachmentId) {
			this.attachmentViewerAttachment = {
				...this.attachmentViewerAttachment,
				extractedText,
			};
		}
	};

	private enqueueApprovalRequest(request: ComposerActionApprovalRequest) {
		if (this.pendingApprovalQueue.some((entry) => entry.id === request.id)) {
			return;
		}
		this.pendingApprovalQueue = [...this.pendingApprovalQueue, request];
	}

	private clearApprovalRequest(requestId: string) {
		this.pendingApprovalQueue = this.pendingApprovalQueue.filter(
			(request) => request.id !== requestId,
		);
	}

	private enqueueToolRetryRequest(request: ComposerToolRetryRequest) {
		if (this.pendingToolRetryQueue.some((entry) => entry.id === request.id)) {
			return;
		}
		this.pendingToolRetryQueue = [...this.pendingToolRetryQueue, request];
	}

	private clearToolRetryRequest(requestId: string) {
		this.pendingToolRetryQueue = this.pendingToolRetryQueue.filter(
			(request) => request.id !== requestId,
		);
	}

	private enqueueMcpElicitationRequest(
		request: ComposerPendingClientToolRequest,
	) {
		const existingIndex = this.pendingMcpElicitationQueue.findIndex(
			(entry) => entry.toolCallId === request.toolCallId,
		);
		if (existingIndex < 0) {
			this.pendingMcpElicitationQueue = [
				...this.pendingMcpElicitationQueue,
				request,
			];
			return;
		}
		const nextQueue = [...this.pendingMcpElicitationQueue];
		nextQueue[existingIndex] = request;
		this.pendingMcpElicitationQueue = nextQueue;
	}

	private clearMcpElicitationRequest(toolCallId: string) {
		this.pendingMcpElicitationQueue = this.pendingMcpElicitationQueue.filter(
			(request) => request.toolCallId !== toolCallId,
		);
	}

	private enqueueUserInputRequest(request: ComposerPendingClientToolRequest) {
		const existingIndex = this.pendingUserInputQueue.findIndex(
			(entry) => entry.toolCallId === request.toolCallId,
		);
		if (existingIndex < 0) {
			this.pendingUserInputQueue = [...this.pendingUserInputQueue, request];
			return;
		}
		const nextQueue = [...this.pendingUserInputQueue];
		nextQueue[existingIndex] = request;
		this.pendingUserInputQueue = nextQueue;
	}

	private clearUserInputRequest(toolCallId: string) {
		this.pendingUserInputQueue = this.pendingUserInputQueue.filter(
			(request) => request.toolCallId !== toolCallId,
		);
	}

	private resetPendingSessionRequestUiState() {
		this.pendingApprovalQueue = [];
		this.approvalSubmitting = false;
		this.pendingToolRetryQueue = [];
		this.toolRetrySubmitting = false;
		this.pendingMcpElicitationQueue = [];
		this.mcpElicitationSubmitting = false;
		this.pendingUserInputQueue = [];
		this.userInputSubmitting = false;
	}

	private restorePendingSessionRequests(session: Session) {
		this.pendingApprovalQueue = Array.isArray(session.pendingApprovalRequests)
			? [...session.pendingApprovalRequests]
			: [];
		this.approvalSubmitting = false;
		this.pendingToolRetryQueue = Array.isArray(session.pendingToolRetryRequests)
			? [...session.pendingToolRetryRequests]
			: [];
		this.toolRetrySubmitting = false;

		const pendingClientToolRequests = Array.isArray(
			session.pendingClientToolRequests,
		)
			? [...session.pendingClientToolRequests]
			: [];
		this.pendingMcpElicitationQueue = pendingClientToolRequests.filter(
			isMcpElicitationRequest,
		);
		this.mcpElicitationSubmitting = false;
		this.pendingUserInputQueue =
			pendingClientToolRequests.filter(isUserInputRequest);
		this.userInputSubmitting = false;
		const replayableClientToolRequests = pendingClientToolRequests.filter(
			(request) =>
				!isUserInputRequest(request) && !isMcpElicitationRequest(request),
		);
		if (replayableClientToolRequests.length === 0) {
			return;
		}

		void this.replayPendingClientToolRequests(
			session.id,
			replayableClientToolRequests,
		);
	}

	private async replayPendingClientToolRequests(
		sessionId: string,
		requests: ComposerPendingClientToolRequest[],
	) {
		for (const request of requests) {
			if (this.currentSessionId !== sessionId || this.shareToken) {
				return;
			}
			await this.handleClientToolRequest(
				request.toolCallId,
				request.toolName,
				request.args,
			);
		}
	}

	private async recoverPendingSessionRequests(
		sessionId: string | null | undefined,
	): Promise<void> {
		if (!sessionId || this.shareToken) {
			return;
		}

		try {
			const session = await this.apiClient.getSession(sessionId);
			if (!session?.id || session.id !== this.currentSessionId) {
				return;
			}
			this.restorePendingSessionRequests(session);
		} catch (error) {
			console.warn("Failed to recover pending session requests", error);
		}
	}

	private async handleClientToolRequest(
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<void> {
		if (toolName === "mcp_elicitation") {
			this.enqueueMcpElicitationRequest({
				toolCallId,
				toolName,
				args,
				kind: "mcp_elicitation",
			});
			return;
		}

		if (toolName === "ask_user") {
			this.enqueueUserInputRequest({
				toolCallId,
				toolName,
				args,
				kind: "user_input",
			});
			return;
		}

		if (toolName === "artifacts") {
			const argsRecord = coerceArtifactsArgs(args);
			if (argsRecord.command === "logs" && argsRecord.filename) {
				const sandboxId = `artifact:${argsRecord.filename}`;
				const snap = getSandboxConsoleSnapshot(sandboxId);
				const logs = snap?.logs ?? [];
				const error = snap?.lastError ?? null;
				const text = (() => {
					if (logs.length === 0 && !error) {
						return `No logs captured for ${argsRecord.filename}. Open the artifact preview to generate logs.`;
					}
					const lines: string[] = [`Logs for ${argsRecord.filename}`, ""];
					for (const line of logs) {
						lines.push(`[${line.level}] ${line.text}`);
					}
					if (error) {
						lines.push("", "Last error:", error.message);
						if (error.stack) lines.push(error.stack);
					}
					return lines.filter(Boolean).join("\n");
				})();
				await this.apiClient.sendClientToolResult({
					toolCallId,
					content: [{ type: "text", text }],
					isError: false,
				});
				return;
			}

			const result = applyArtifactsCommand(this.artifactsState, argsRecord);
			this.artifactsState = result.state;
			if (!result.isError && argsRecord.filename) {
				this.setActiveArtifact(argsRecord.filename);
			}
			await this.apiClient.sendClientToolResult({
				toolCallId,
				content: [{ type: "text", text: result.output }],
				isError: result.isError,
			});
			return;
		}

		if (toolName === "javascript_repl") {
			const result = await this.runJavascriptRepl(args);
			await this.apiClient.sendClientToolResult({
				toolCallId,
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
			});
			return;
		}

		if (
			toolName === "list_mcp_servers" ||
			toolName === "list_mcp_tools" ||
			toolName === "list_mcp_resources" ||
			toolName === "read_mcp_resource" ||
			toolName === "list_mcp_prompts" ||
			toolName === "get_mcp_prompt"
		) {
			try {
				const res = await this.runMcpClientTool(toolName, args);
				await this.apiClient.sendClientToolResult({
					toolCallId,
					content: [{ type: "text", text: res.text }],
					isError: res.isError,
				});
			} catch (error) {
				await this.apiClient.sendClientToolResult({
					toolCallId,
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					isError: true,
				});
			}
			return;
		}

		await this.apiClient.sendClientToolResult({
			toolCallId,
			content: [
				{
					type: "text",
					text: `Unsupported client tool: ${toolName}`,
				},
			],
			isError: true,
		});
	}

	private handleApproveRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitApprovalDecision("approved", e.detail?.requestId);
	};

	private handleDenyRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitApprovalDecision("denied", e.detail?.requestId);
	};

	private handleRetryRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitToolRetryDecision("retry", e.detail?.requestId);
	};

	private handleSkipRetryRequest = (e: CustomEvent<{ requestId?: string }>) => {
		void this.submitToolRetryDecision("skip", e.detail?.requestId);
	};

	private handleAbortRetryRequest = (
		e: CustomEvent<{ requestId?: string }>,
	) => {
		void this.submitToolRetryDecision("abort", e.detail?.requestId);
	};

	private handleSubmitUserInputRequest = (
		e: CustomEvent<{ toolCallId?: string; responseText?: string }>,
	) => {
		void this.submitUserInputResponse(
			e.detail?.responseText,
			e.detail?.toolCallId,
		);
	};

	private handleCancelUserInputRequest = (
		e: CustomEvent<{ toolCallId?: string }>,
	) => {
		void this.submitUserInputResponse(
			"User cancelled structured input request.",
			e.detail?.toolCallId,
			true,
		);
	};

	private handleSubmitMcpElicitationRequest = (
		e: CustomEvent<{
			toolCallId?: string;
			action?: "accept" | "decline";
			content?: Record<string, string | number | boolean | string[]>;
		}>,
	) => {
		void this.submitMcpElicitationResponse(
			e.detail?.toolCallId,
			e.detail?.action,
			e.detail?.content,
		);
	};

	private handleCancelMcpElicitationRequest = (
		e: CustomEvent<{ toolCallId?: string }>,
	) => {
		void this.submitMcpElicitationResponse(e.detail?.toolCallId, "cancel");
	};

	private async submitApprovalDecision(
		decision: "approved" | "denied",
		requestId?: string,
	) {
		if (!requestId || this.approvalSubmitting) {
			return;
		}

		this.approvalSubmitting = true;

		try {
			await this.apiClient.submitApprovalDecision({ requestId, decision });
			this.clearApprovalRequest(requestId);
			this.showToast(
				decision === "approved" ? "Approval submitted" : "Denial submitted",
				decision === "approved" ? "success" : "info",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit approval decision",
				"error",
				2200,
			);
		} finally {
			this.approvalSubmitting = false;
		}
	}

	private async submitToolRetryDecision(
		action: "retry" | "skip" | "abort",
		requestId?: string,
	) {
		if (!requestId || this.toolRetrySubmitting) {
			return;
		}

		this.toolRetrySubmitting = true;

		try {
			await this.apiClient.submitToolRetryDecision({ requestId, action });
			this.clearToolRetryRequest(requestId);
			this.showToast(
				action === "retry"
					? "Retry submitted"
					: action === "skip"
						? "Retry skipped"
						: "Retry aborted",
				action === "abort" ? "info" : "success",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit retry decision",
				"error",
				2200,
			);
		} finally {
			this.toolRetrySubmitting = false;
		}
	}

	private async submitUserInputResponse(
		responseText?: string,
		toolCallId?: string,
		isError = false,
	) {
		const trimmedResponse = responseText?.trim();
		if (!toolCallId || this.userInputSubmitting) {
			return;
		}
		if (!trimmedResponse) {
			this.showToast(
				"Select an option or enter a custom response",
				"info",
				1800,
			);
			return;
		}

		this.userInputSubmitting = true;

		try {
			await this.apiClient.sendClientToolResult({
				toolCallId,
				content: [{ type: "text", text: trimmedResponse }],
				isError,
			});
			this.clearUserInputRequest(toolCallId);
			this.showToast(
				isError ? "Input request cancelled" : "Input submitted",
				isError ? "info" : "success",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit input response",
				"error",
				2200,
			);
		} finally {
			this.userInputSubmitting = false;
		}
	}

	private async submitMcpElicitationResponse(
		toolCallId?: string,
		action: "accept" | "decline" | "cancel" = "cancel",
		content?: Record<string, string | number | boolean | string[]>,
	) {
		if (!toolCallId || this.mcpElicitationSubmitting) {
			return;
		}

		this.mcpElicitationSubmitting = true;

		try {
			await this.apiClient.sendClientToolResult({
				toolCallId,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							action,
							...(action === "accept" && content ? { content } : {}),
						}),
					},
				],
				isError: false,
			});
			this.clearMcpElicitationRequest(toolCallId);
			this.showToast(
				action === "accept"
					? "MCP input submitted"
					: action === "decline"
						? "MCP request declined"
						: "MCP request cancelled",
				action === "accept" ? "success" : "info",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit MCP response",
				"error",
				2200,
			);
		} finally {
			this.mcpElicitationSubmitting = false;
		}
	}

	private getShareTokenFromLocation(): string | null {
		if (typeof window === "undefined") return null;
		try {
			const url = new URL(window.location.href);
			const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname || "/");
			if (match?.[1]) return match[1];
			return (
				url.searchParams.get("share") ||
				url.searchParams.get("shareToken") ||
				url.searchParams.get("token")
			);
		} catch {
			return null;
		}
	}

	private async loadSharedSession(shareToken: string) {
		this.loading = true;
		this.error = null;
		try {
			const session = await this.apiClient.getSharedSession(shareToken);
			if (!session || !session.id) {
				throw new Error("Invalid shared session response");
			}
			this.currentSessionId = session.id;
			this.resetVirtualizationState();
			this.messages = Array.isArray(session.messages)
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.sessions = [];
			this.attachmentContentCache.clear();
			this.artifactsState = reconstructArtifactsFromMessages(this.messages);
			this.activeArtifact = null;
			this.artifactsOpen = false;
			this.error = null;
			this.requestUpdate();
			await this.updateComplete;
			this.scrollToBottom({ force: true });
		} catch (e) {
			console.error("Failed to load shared session:", e);
			this.error =
				e instanceof Error ? e.message : "Failed to load shared session";
			this.showToast(this.error, "error");
		} finally {
			this.runtimeStatus = null;
			this.loading = false;
		}
	}

	private toggleCompact() {
		const next = !this.compactMode;
		this.compactMode = next;
		try {
			localStorage.setItem(ComposerChat.COMPACT_KEY, next ? "true" : "false");
		} catch {
			/* ignore storage errors */
		}
		if (!this.shareToken && this.currentSessionId) {
			this.apiClient
				.setCompactTools(next, this.currentSessionId)
				.catch((err) => {
					console.warn("Failed to persist compact mode", err);
				});
		}
		this.showToast(next ? "Compact mode on" : "Compact mode off", "info", 1500);
	}

	private closeCommandDrawer() {
		this.commandDrawerOpen = false;
		this.scheduleComposerInputFocus();
	}

	private getComposerInput(): ComposerInput | null {
		return this.shadowRoot?.querySelector(
			"composer-input",
		) as ComposerInput | null;
	}

	private focusComposerInput() {
		this.getComposerInput()?.focusInput?.();
	}

	private scheduleComposerInputFocus() {
		void this.updateComplete.then(() => {
			this.focusComposerInput();
		});
	}

	private setComposerInputValue(text: string) {
		this.getComposerInput()?.setValue?.(text);
	}

	private handleCommandSelect(name: string) {
		this.setComposerInputValue(`/${name} `);
		const recents = [
			name,
			...this.commandPrefs.recents.filter((n) => n !== name),
		].slice(0, 20);
		void this.saveCommandPrefs({
			favorites: this.commandPrefs.favorites,
			recents,
		});
		this.closeCommandDrawer();
	}

	private handleToggleFavorite(name: string) {
		const favorites = this.commandPrefs.favorites.includes(name)
			? this.commandPrefs.favorites.filter((n) => n !== name)
			: [...this.commandPrefs.favorites, name];
		void this.saveCommandPrefs({
			favorites,
			recents: this.commandPrefs.recents,
		});
	}

	private async loadCommandPrefs() {
		try {
			const prefs = await this.apiClient.getCommandPrefs();
			this.commandPrefs = prefs;
		} catch (e) {
			console.warn("Failed to load command prefs", e);
		}
	}

	private async loadSlashCommands() {
		try {
			const commands = await this.apiClient.getCommands();
			this.slashCommands = buildWebSlashCommands(commands);
		} catch (e) {
			console.warn("Failed to load slash commands", e);
			this.slashCommands = WEB_SLASH_COMMANDS;
		}
	}

	private async saveCommandPrefs(prefs: {
		favorites: string[];
		recents: string[];
	}) {
		this.commandPrefs = prefs;
		try {
			await this.apiClient.saveCommandPrefs(prefs);
		} catch (e) {
			console.warn("Failed to save command prefs", e);
		}
	}
	private toggleReducedMotion() {
		this.reducedMotion = !this.reducedMotion;
		try {
			localStorage.setItem(
				ComposerChat.REDUCED_MOTION_KEY,
				this.reducedMotion ? "true" : "false",
			);
		} catch {
			/* ignore storage errors */
		}
		this.showToast(
			this.reducedMotion ? "Reduced motion on" : "Reduced motion off",
			"info",
			1500,
		);
	}

	private applyTheme(theme: "dark" | "light", persist = true) {
		this.theme = theme;
		if (typeof document !== "undefined") {
			document.documentElement.dataset.theme = theme;
		}
		if (persist) {
			try {
				localStorage.setItem(THEME_KEY, theme);
			} catch {
				/* ignore storage errors */
			}
		}
	}

	private toggleTheme() {
		const next = this.theme === "dark" ? "light" : "dark";
		this.applyTheme(next);
		this.showToast(`${next === "dark" ? "Dark" : "Light"} theme`, "info", 1500);
	}

	private setTransportPreference(mode: "auto" | "sse" | "ws", persist = true) {
		this.transportPreference = mode;
		this.apiClient.setTransportPreference(mode);
		if (persist) {
			try {
				localStorage.setItem(TRANSPORT_KEY, mode);
			} catch {
				/* ignore storage errors */
			}
		}
	}

	private applyZenMode(enabled: boolean) {
		this.zenMode = enabled;
		this.toggleAttribute("zen", enabled);
		if (enabled) {
			this.sidebarOpen = false;
		}
	}

	private async refreshUiState(sessionId?: string) {
		const targetId = sessionId ?? this.currentSessionId;
		if (!targetId || this.shareToken) return;
		try {
			const ui = await this.apiClient.getUIStatus(targetId);
			if (ui.cleanMode) this.cleanMode = ui.cleanMode;
			if (ui.footerMode) this.footerMode = ui.footerMode;
			if (ui.queueMode) this.queueMode = ui.queueMode;
			if (typeof ui.compactTools === "boolean") {
				this.compactMode = ui.compactTools;
			}
			if (typeof ui.zenMode === "boolean") {
				this.applyZenMode(ui.zenMode);
			}
		} catch (e) {
			console.warn("Failed to load UI status", e);
		}
	}

	override connectedCallback() {
		super.connectedCallback();
		this.apiClient = new ApiClient(this.apiEndpoint);
		this.subscribeToStore();
		const shareToken = this.getShareTokenFromLocation();
		if (shareToken) {
			this.shareToken = shareToken;
			this.sidebarOpen = false;
			void this.loadSharedSession(shareToken);
		} else {
			this.loadCurrentModel();
			void this.loadApprovalModeStatus();
			this.loadSessions();
			this.loadSlashCommands();
			dataStore.ensureStatus(this.apiClient);
			dataStore.ensureModels(this.apiClient);
			dataStore.ensureUsage(this.apiClient);
			this.loadCommandPrefs();
		}
		this.hydrateDisplayPrefs();
		window.addEventListener("online", this.handleOnline);
		window.addEventListener("offline", this.handleOffline);
		window.addEventListener("keydown", this.handleKeydown);
		this.addEventListener(
			"open-attachment",
			this.handleOpenAttachment as EventListener,
		);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this.unsubscribeStore) this.unsubscribeStore();
		window.removeEventListener("online", this.handleOnline);
		window.removeEventListener("offline", this.handleOffline);
		window.removeEventListener("keydown", this.handleKeydown);
		this.removeEventListener(
			"open-attachment",
			this.handleOpenAttachment as EventListener,
		);
		const scroller = this.getMessagesScroller();
		scroller?.removeEventListener("scroll", this.handleMessagesScroll);
		if (this.messagesScrollRaf !== null) {
			if (window.cancelAnimationFrame) {
				window.cancelAnimationFrame(this.messagesScrollRaf);
			} else {
				window.clearTimeout(this.messagesScrollRaf);
			}
			this.messagesScrollRaf = null;
		}
		if (this.historyObserver) {
			try {
				this.historyObserver.disconnect();
			} catch {
				// ignore
			}
			this.historyObserver = null;
			this.observedHistoryEl = null;
		}
		if (this.messageResizeObserver) {
			try {
				this.messageResizeObserver.disconnect();
			} catch {
				// ignore
			}
			this.messageResizeObserver = null;
			this.observedMessageNodes.clear();
		}
	}

	protected override firstUpdated(): void {
		const scroller = this.getMessagesScroller();
		scroller?.addEventListener("scroll", this.handleMessagesScroll, {
			passive: true,
		});
		this.ensureHistoryObserver();
		this.refreshHistoryObserverTarget();

		if (this.renderEndIndex === 0) {
			this.renderEndIndex = this.messages.length;
		}
		this.lastMessagesLength = this.messages.length;
		this.updateVirtualWindow();
		if (typeof window !== "undefined") {
			const raf = window.requestAnimationFrame
				? window.requestAnimationFrame.bind(window)
				: (cb: FrameRequestCallback) =>
						window.setTimeout(() => cb(Date.now()), 16);
			raf(() => this.captureMessageHeights());
		}
	}

	protected override updated(changed: PropertyValues): void {
		super.updated(changed);
		this.ensureHistoryObserver();
		this.refreshHistoryObserverTarget();

		const total = this.messages.length;
		if (this.renderEndIndex > total) {
			this.renderEndIndex = total;
		}
		if (this.renderEndIndex === 0 && total > 0) {
			this.renderEndIndex = total;
		}

		if (changed.has("messages")) {
			const prev = changed.get("messages") as UiMessage[] | undefined;
			const prevLen = Array.isArray(prev)
				? prev.length
				: this.lastMessagesLength;
			const nextLen = total;
			const delta = nextLen - prevLen;
			this.lastMessagesLength = nextLen;

			if (delta > 0) {
				if (this.autoScroll) {
					if (this.renderEndIndex !== nextLen) this.renderEndIndex = nextLen;
					if (this.unseenMessages !== 0) this.unseenMessages = 0;
				} else {
					this.unseenMessages += delta;
				}
			} else if (nextLen === 0) {
				this.unseenMessages = 0;
				this.messageHeights.clear();
				this.virtualStartIndex = 0;
				this.virtualEndIndex = 0;
				this.virtualPaddingTop = 0;
				this.virtualPaddingBottom = 0;
			}
		}

		if (
			changed.has("messages") ||
			changed.has("currentSessionId") ||
			changed.has("shareToken")
		) {
			this.artifactsPanelAttachmentsRequestId += 1;
			this.artifactsPanelAttachments = this.getAllAttachments();
			if (this.artifactsOpen) {
				void this.refreshArtifactsPanelAttachments();
			}
		}

		if (this.autoScroll && this.renderEndIndex !== total) {
			this.renderEndIndex = total;
		}

		if (
			changed.has("messages") ||
			changed.has("renderLimit") ||
			changed.has("renderEndIndex")
		) {
			if (typeof window !== "undefined") {
				const raf = window.requestAnimationFrame
					? window.requestAnimationFrame.bind(window)
					: (cb: FrameRequestCallback) =>
							window.setTimeout(() => cb(Date.now()), 16);
				raf(() => {
					this.syncMessageObservers();
					this.captureMessageHeights();
					this.updateVirtualWindow();
				});
			}
		}

		if (changed.has("currentSessionId")) {
			this.resetPendingSessionRequestUiState();
			if (this.currentSessionId) {
				void this.refreshUiState(this.currentSessionId);
			}
			if (!this.shareToken) {
				this.clearApprovalModeStatus();
				void this.loadApprovalModeStatus();
			}
		}

		if (changed.has("shareToken")) {
			if (this.shareToken) {
				this.clearApprovalModeStatus();
			} else {
				void this.loadApprovalModeStatus();
			}
		}
	}

	private hydrateDisplayPrefs() {
		if (typeof window === "undefined") return;
		try {
			const compact = localStorage.getItem(ComposerChat.COMPACT_KEY);
			if (compact) this.compactMode = compact === "true";
			const rm = localStorage.getItem(ComposerChat.REDUCED_MOTION_KEY);
			if (rm) this.reducedMotion = rm === "true";
			const theme = localStorage.getItem(THEME_KEY);
			if (theme === "dark" || theme === "light") {
				this.applyTheme(theme, false);
			} else if (window.matchMedia) {
				const prefersLight = window.matchMedia(
					"(prefers-color-scheme: light)",
				).matches;
				this.applyTheme(prefersLight ? "light" : "dark", false);
			}
			const transport = localStorage.getItem(TRANSPORT_KEY);
			if (transport === "auto" || transport === "sse" || transport === "ws") {
				this.setTransportPreference(transport, false);
			}
		} catch {
			/* ignore storage errors */
		}
	}

	private subscribeToStore() {
		// hydrate from cache immediately
		if (typeof window !== "undefined") {
			try {
				const savedModel = localStorage.getItem(MODEL_OVERRIDE_KEY);
				if (savedModel) this.currentModel = savedModel;
				const statusCache = localStorage.getItem(STATUS_CACHE_KEY);
				if (statusCache) this.status = JSON.parse(statusCache);
				const modelsCache = localStorage.getItem(MODELS_CACHE_KEY);
				if (modelsCache) this.models = JSON.parse(modelsCache);
				const usageCache = localStorage.getItem(USAGE_CACHE_KEY);
				if (usageCache) this.usage = JSON.parse(usageCache);
			} catch {
				/* ignore cache parse errors */
			}
		}

		this.unsubscribeStore = dataStore.subscribe((snapshot) => {
			this.status = snapshot.status;
			this.models = snapshot.models;
			this.usage = snapshot.usage;
			if (!this.currentModelTokens && snapshot.models.length > 0) {
				this.updateModelMeta();
			}
		});
	}

	private async loadCurrentModel() {
		try {
			const model = await this.apiClient.getCurrentModel();
			this.currentModel = model ? `${model.provider}/${model.id}` : this.model;
			const tokens = this.deriveModelTokens(model);
			this.currentModelTokens = tokens;
		} catch (e) {
			console.error("Failed to load current model:", e);
			this.currentModel = this.model;
			this.currentModelTokens = null;
		}
	}

	private deriveModelTokens(
		model: Partial<{
			contextWindow?: number;
			maxOutputTokens?: number;
			maxTokens?: number;
		}> | null,
	): string | null {
		if (!model) return null;
		if (model.contextWindow)
			return `${Math.round(model.contextWindow / 1000)}k ctx`;
		if (model.maxOutputTokens)
			return `${Math.round(model.maxOutputTokens / 1000)}k max out`;
		if (model.maxTokens) return `${Math.round(model.maxTokens / 1000)}k tokens`;
		return null;
	}

	private async updateModelMeta() {
		// Avoid extra fetches when we already have tokens or no models yet
		if (this.currentModelTokens && this.models.length === 0) return;
		try {
			const models =
				this.models.length > 0 ? this.models : await this.apiClient.getModels();
			const current =
				models.find((m) => `${m.provider}/${m.id}` === this.currentModel) ??
				models.find((m) => m.id === this.currentModel);
			const tokens = this.deriveModelTokens(current || null);
			this.currentModelTokens = tokens ?? "n/a";
		} catch (e) {
			console.error("Failed to load model metadata:", e);
			this.currentModelTokens = "n/a";
		}
	}

	private coerceMessageContent(content: Message["content"]): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block) => block?.type === "text")
			.map((block) => (block?.type === "text" ? block.text : ""))
			.join("");
	}

	private normalizeMessage(message: Message): Message {
		if (typeof message.content === "string") return message;
		return {
			...message,
			content: this.coerceMessageContent(message.content),
		};
	}

	private normalizeMessages(messages: Message[]): UiMessage[] {
		return messages.map((message) => this.normalizeMessage(message));
	}

	private isSlashCommand(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) return false;
		if (trimmed.startsWith("//")) return false;
		return trimmed.length > 1;
	}

	private appendLocalMessage(message: UiMessage) {
		const next = [...this.messages, message];
		this.messages = next;
		this.autoScroll = true;
		this.unseenMessages = 0;
		this.renderEndIndex = next.length;
		this.lastMessagesLength = next.length;
		this.scrollToBottom({ force: true });
	}

	private appendCommandOutput(
		command: string,
		output: string,
		isError = false,
	) {
		const label = isError ? "Command failed" : "Command output";
		const content = `/${command}\n\n${output}`;
		this.appendLocalMessage({
			role: "assistant",
			content: content || label,
			timestamp: new Date().toISOString(),
			localOnly: true,
		});
	}

	private async handleSlashCommand(
		rawText: string,
		attachments?: Message["attachments"],
	) {
		const text = rawText.trim();
		const [, ...rest] = text.split(/\s+/);
		const command = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
		const args = rest.join(" ").trim();

		this.appendLocalMessage({
			role: "user",
			content: text,
			timestamp: new Date().toISOString(),
			localOnly: true,
		});

		if (command) {
			const recents = [
				command,
				...this.commandPrefs.recents.filter((n) => n !== command),
			].slice(0, 20);
			void this.saveCommandPrefs({
				favorites: this.commandPrefs.favorites,
				recents,
			});
		}

		if (attachments && attachments.length > 0) {
			this.appendCommandOutput(
				command,
				"Attachments are not supported for slash commands.",
				true,
			);
			return;
		}

		await executeWebSlashCommand(command, args, {
			apiClient: this.apiClient,
			appendCommandOutput: (output, isError = false) =>
				this.appendCommandOutput(command, output, isError),
			applyTheme: (theme) => this.applyTheme(theme),
			applyZenMode: (enabled) => this.applyZenMode(enabled),
			commands: this.slashCommands,
			createNewSession: () => this.createNewSession(),
			currentSessionId: this.currentSessionId,
			isSharedSession: Boolean(this.shareToken),
			openCommandDrawer: () => {
				this.commandDrawerOpen = true;
			},
			openModelSelector: () => this.openModelSelector(),
			selectSession: (sessionId) => this.selectSession(sessionId),
			setApprovalModeStatus: (status) => this.updateApprovalModeStatus(status),
			setCleanMode: (mode) => {
				this.cleanMode = mode;
			},
			setCurrentModel: (model) => {
				this.currentModel = model;
			},
			setFooterMode: (mode) => {
				this.footerMode = mode;
			},
			setInputValue: (text) => {
				this.setComposerInputValue(text);
			},
			setQueueMode: (mode) => {
				this.queueMode = mode;
			},
			setTransportPreference: (mode) => this.setTransportPreference(mode),
			theme: this.theme,
			updateModelMeta: () => this.updateModelMeta(),
			zenMode: this.zenMode,
		});
	}

	private async loadSessions() {
		try {
			this.sessions = await this.apiClient.getSessions();
		} catch (e) {
			console.error("Failed to load sessions:", e);
		}
	}

	private renderIcon(
		name:
			| "chevron-left"
			| "chevron-right"
			| "info"
			| "refresh"
			| "globe"
			| "share"
			| "settings"
			| "sun"
			| "moon"
			| "grid"
			| "file"
			| "reduce"
			| "close",
	) {
		const paths: Record<string, string> = {
			"chevron-left": "M15 18l-6-6 6-6",
			"chevron-right": "M9 6l6 6-6 6",
			info: "M12 12v4m0-8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z",
			refresh:
				"M4.93 4.93A10 10 0 0 1 19.07 5M20 9v-4h-4M19.07 19.07A10 10 0 0 1 4.93 19M4 15v4h4",
			globe:
				"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c3 0 5-4 5-9s-2-9-5-9-5 4-5 9 2 9 5 9Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12 9.5 21 12 21Zm0-9h9M3 12h9",
			share:
				"M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 0 6Zm-12 4a3 3 0 1 0 2.83 4H9a3 3 0 0 0 0-6Zm12 0a3 3 0 1 0 2.83 4H21a3 3 0 0 0 0-6Zm-4.59-1.51L8.59 15.5M15.41 8.5 8.59 11.5",
			settings:
				"M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.63a1 1 0 0 0 0-1.74l-1.17-.68a1 1 0 0 1-.46-.86l.05-1.35a1 1 0 0 0-1.17-1.01l-1.35.23a1 1 0 0 1-.9-.26L13.2 6a1 1 0 0 0-1.4 0l-.9.9a1 1 0 0 1-.9.26l-1.35-.23a1 1 0 0 0-1.17 1.01l.05 1.35a1 1 0 0 1-.46.86l-1.17.68a1 1 0 0 0 0 1.74l1.17.68a1 1 0 0 1 .46.86l-.05 1.35a1 1 0 0 0 1.17 1.01l1.35-.23a1 1 0 0 1 .9.26l.9.9a1 1 0 0 0 1.4 0l.9-.9a1 1 0 0 1 .9-.26l1.35.23a1 1 0 0 0 1.17-1.01l-.05-1.35a1 1 0 0 1 .46-.86Z",
			sun: "M12 4.5V3M12 21v-1.5M4.5 12H3m18 0h-1.5M6.75 6.75 5.7 5.7m12.6 12.6-1.05-1.05M6.75 17.25 5.7 18.3m12.6-12.6-1.05 1.05M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
			moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
			grid: "M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 7v-7h7v7Z",
			file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
			reduce: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm-5-9h10",
			close: "M18 6 6 18M6 6l12 12",
		};
		return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d=${paths[name]}></path>
		</svg>`;
	}

	private toggleSidebar() {
		this.sidebarOpen = !this.sidebarOpen;
	}

	private handleExitSharedSession = () => {
		window.location.href = "/";
	};

	private handleDialogNotice = (
		event: CustomEvent<{
			message?: string;
			type?: "info" | "error" | "success";
			duration?: number;
		}>,
	) => {
		if (!event.detail?.message || !event.detail?.type) return;
		this.showToast(
			event.detail.message,
			event.detail.type,
			event.detail.duration,
		);
	};

	private handleSelectSession = (
		event: CustomEvent<{ sessionId?: unknown }>,
	) => {
		const sessionId = event.detail?.sessionId;
		if (typeof sessionId !== "string") return;
		void this.selectSession(sessionId);
	};

	private handleDeleteSession = (
		event: CustomEvent<{ sessionId?: unknown }>,
	) => {
		const sessionId = event.detail?.sessionId;
		if (typeof sessionId !== "string") return;
		void this.deleteSession(sessionId);
	};

	private handleUpdateSession = (
		event: CustomEvent<{
			sessionId?: unknown;
			updates?: { favorite?: boolean; tags?: string[]; title?: string };
		}>,
	) => {
		const sessionId = event.detail?.sessionId;
		const updates = event.detail?.updates;
		if (typeof sessionId !== "string" || !updates) return;
		void this.updateSessionMetadata(sessionId, updates);
	};

	private toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
	}

	private hasAdminSettingsAccess() {
		return Boolean(
			this.status?.database.configured && this.status.database.connected,
		);
	}

	private toggleAdminSettings() {
		if (!this.hasAdminSettingsAccess()) {
			return;
		}
		this.adminSettingsOpen = !this.adminSettingsOpen;
	}

	private openShareDialog = async () => {
		if (this.shareToken) return;
		if (!this.currentSessionId) {
			this.showToast("Create or select a session first", "info", 1800);
			return;
		}
		this.shareDialogOpen = true;
	};

	private closeShareDialog = () => {
		this.shareDialogOpen = false;
	};

	private openExportDialog = async () => {
		if (this.shareToken) return;
		if (!this.currentSessionId) {
			this.showToast("Create or select a session first", "info", 1800);
			return;
		}
		this.exportDialogOpen = true;
	};

	private closeExportDialog = () => {
		this.exportDialogOpen = false;
	};

	private toggleArtifactsPanel() {
		this.artifactsOpen = !this.artifactsOpen;
		if (this.artifactsOpen) {
			void this.refreshArtifactsPanelAttachments();
		}
	}

	private closeArtifactsPanel() {
		this.artifactsOpen = false;
		this.artifactsPanelAttachmentsRequestId += 1;
	}

	private setActiveArtifact(filename: string) {
		this.activeArtifact = filename;
		this.artifactsOpen = true;
		void this.refreshArtifactsPanelAttachments();
	}

	private handleOpenArtifact = (e: Event) => {
		const evt = e as CustomEvent<{ filename?: unknown }>;
		const filename = evt.detail?.filename;
		if (typeof filename !== "string" || filename.trim().length === 0) return;
		e.stopPropagation();
		this.setActiveArtifact(filename);
	};

	private openModelSelector() {
		// Ensure models are ready for the dialog
		dataStore.ensureModels(this.apiClient);
		this.showModelSelector = true;
	}

	private closeModelSelector() {
		this.showModelSelector = false;
	}

	private handleModelSelect(event: CustomEvent) {
		const selected = event.detail.model as string;
		this.currentModel = selected;
		localStorage.setItem(MODEL_OVERRIDE_KEY, selected);
		// Persist selection server-side if possible
		this.apiClient
			.setModel(selected)
			.catch((err) => console.error("Failed to set model:", err));
		// Update tokens from cached models; fall back to later refresh if missing
		const cached = this.models.find(
			(m) => `${m.provider}/${m.id}` === selected || m.id === selected,
		);
		if (cached) {
			this.currentModelTokens =
				this.deriveModelTokens(cached) ?? this.currentModelTokens;
		} else {
			this.currentModelTokens = this.currentModelTokens ?? null;
		}
		if (this.models.length === 0) {
			this.updateModelMeta();
		}
		this.closeModelSelector();
		this.showToast("Model updated", "success");
	}

	private async createNewSession() {
		this.error = null;
		this.runtimeStatus = null;
		try {
			const session = await this.apiClient.createSession("New Chat");
			this.currentSessionId = session.id;
			this.resetVirtualizationState();
			this.messages = Array.isArray(session.messages)
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.attachmentContentCache.clear();
			this.artifactsState = createEmptyArtifactsState();
			this.activeArtifact = null;
			await this.refreshUiState(session.id);
			await this.loadSessions();
			this.showToast("New session created", "success");
		} catch (e) {
			this.error =
				e instanceof Error ? e.message : "Failed to create new session";
			this.showToast(this.error, "error");
		}
	}

	private async updateSessionMetadata(
		sessionId: string,
		updates: Partial<Pick<SessionSummary, "favorite" | "tags" | "title">>,
	) {
		try {
			const updated = await this.apiClient.updateSession(sessionId, updates);
			this.sessions = this.sessions.map((session) =>
				session.id === sessionId ? { ...session, ...updated } : session,
			);
			await this.loadSessions();
			this.showToast("Session updated", "success", 1500);
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Failed to update session";
			this.showToast(message, "error");
		}
	}

	private getApprovalModeSessionId(): string {
		return this.currentSessionId ?? "default";
	}

	private clearApprovalModeStatus() {
		this.approvalModeRequestId += 1;
		this.approvalMode = null;
		this.approvalModeNotice = null;
		this.approvalModeNoticeSessionId = null;
	}

	private updateApprovalModeStatus(options: {
		mode: ComposerApprovalMode;
		message?: string;
		notify?: boolean;
		sessionId?: string | null;
	}) {
		const sessionId = options.sessionId ?? this.getApprovalModeSessionId();
		if (this.shareToken || sessionId !== this.getApprovalModeSessionId()) {
			return;
		}
		this.approvalModeRequestId += 1;
		const note =
			typeof options.message === "string" &&
			options.message.includes("server default is stricter")
				? options.message
				: null;

		this.approvalMode = options.mode;
		this.approvalModeNotice = note;
		this.approvalModeNoticeSessionId = sessionId;

		if (options.notify && options.message) {
			this.showToast(options.message, note ? "info" : "success", 2200);
		}
	}

	private async loadApprovalModeStatus(
		sessionId = this.getApprovalModeSessionId(),
	) {
		if (this.shareToken) {
			this.clearApprovalModeStatus();
			return;
		}
		const requestId = ++this.approvalModeRequestId;

		try {
			const status = await this.apiClient.getApprovalMode(sessionId);
			if (
				requestId !== this.approvalModeRequestId ||
				this.shareToken ||
				sessionId !== this.getApprovalModeSessionId()
			) {
				return;
			}
			this.approvalMode = status.mode;
			if (this.approvalModeNoticeSessionId !== sessionId) {
				this.approvalModeNotice = null;
				this.approvalModeNoticeSessionId = sessionId;
			}
		} catch (e) {
			if (
				requestId !== this.approvalModeRequestId ||
				this.shareToken ||
				sessionId !== this.getApprovalModeSessionId()
			) {
				return;
			}
			this.approvalMode = null;
			this.approvalModeNotice = null;
			this.approvalModeNoticeSessionId = sessionId;
			console.warn("Failed to load approval mode", e);
		}
	}

	private async refreshArtifactsPanelAttachments() {
		const attachments = this.getAllAttachments();
		this.artifactsPanelAttachments = attachments;

		const sessionId = this.currentSessionId;
		const shareToken = this.shareToken;
		const needsHydration = attachments.some(
			(att) =>
				Boolean(att?.contentOmitted) &&
				!(typeof att.content === "string" && att.content.length > 0),
		);
		if (!needsHydration || (!sessionId && !shareToken)) {
			return;
		}

		const requestId = ++this.artifactsPanelAttachmentsRequestId;
		const hydrated = await this.hydrateAttachmentsForRequest(attachments, {
			sessionId,
			shareToken,
		});
		if (
			requestId !== this.artifactsPanelAttachmentsRequestId ||
			sessionId !== this.currentSessionId ||
			shareToken !== this.shareToken
		) {
			return;
		}
		this.artifactsPanelAttachments = hydrated;
	}

	private async selectSession(sessionId: string) {
		this.runtimeStatus = null;
		try {
			const session = await this.apiClient.getSession(sessionId);
			if (!session || !session.id) {
				throw new Error("Invalid session response");
			}
			this.currentSessionId = session.id;
			this.resetVirtualizationState();
			this.messages = Array.isArray(session.messages)
				? this.normalizeMessages(session.messages)
				: [];
			this.renderLimit = 200;
			this.syncRenderWindowToBottom();
			this.attachmentContentCache.clear();
			this.artifactsState = reconstructArtifactsFromMessages(this.messages);
			this.activeArtifact = null;
			this.error = null;
			await this.updateComplete;
			this.restorePendingSessionRequests(session);
			await this.refreshUiState(session.id);
			this.requestUpdate(); // Force update
			await this.updateComplete; // Wait for render
			this.scrollToBottom({ force: true });
		} catch (e) {
			console.error("Failed to load session:", e);
			this.error = e instanceof Error ? e.message : "Failed to load session";
			this.showToast(this.error, "error");
		}
	}

	private async deleteSession(sessionId: string) {
		if (!confirm("Delete this session?")) return;
		try {
			await this.apiClient.deleteSession(sessionId);
			if (this.currentSessionId === sessionId) {
				this.currentSessionId = null;
				this.messages = [];
				this.syncRenderWindowToBottom();
				this.renderLimit = 200;
				this.attachmentContentCache.clear();
			}
			await this.loadSessions();
			this.showToast("Session deleted", "success");
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to delete session";
			this.showToast(msg, "error");
		}
	}

	private async ensureExtractedTextForAttachments(
		attachments: NonNullable<Message["attachments"]>,
	): Promise<NonNullable<Message["attachments"]>> {
		const out: NonNullable<Message["attachments"]> = [];
		for (const att of attachments) {
			if (!att || typeof att !== "object") continue;

			if (
				att.type !== "document" ||
				typeof att.extractedText === "string" ||
				typeof att.content !== "string" ||
				att.content.length === 0
			) {
				out.push(att);
				continue;
			}

			try {
				const res = await this.apiClient.extractAttachmentText({
					fileName: att.fileName,
					mimeType: att.mimeType,
					contentBase64: att.content,
				});
				out.push({
					...att,
					extractedText: res.extractedText || undefined,
				});
			} catch (e) {
				console.warn("Attachment extraction failed", e);
				out.push(att);
			}
		}
		return out;
	}

	private async hydrateAttachmentForRequest(
		att: NonNullable<Message["attachments"]>[number],
		options: { sessionId?: string | null; shareToken?: string | null },
	): Promise<NonNullable<Message["attachments"]>[number]> {
		const sessionId = options.sessionId ?? null;
		const shareToken = options.shareToken ?? null;
		if (!att?.id) return att;

		if (typeof att.content === "string" && att.content.length > 0) {
			if (!this.attachmentContentCache.has(att.id)) {
				this.attachmentContentCache.set(att.id, att.content);
			}
			return att;
		}

		if (!att.contentOmitted) return att;

		const cached = this.attachmentContentCache.get(att.id);
		if (cached) {
			return { ...att, content: cached, contentOmitted: undefined };
		}

		if (!sessionId && !shareToken) return att;

		try {
			const base64 = shareToken
				? await this.apiClient.getSharedSessionAttachmentContentBase64(
						shareToken,
						att.id,
					)
				: await this.apiClient.getSessionAttachmentContentBase64(
						sessionId,
						att.id,
					);
			this.attachmentContentCache.set(att.id, base64);
			return { ...att, content: base64, contentOmitted: undefined };
		} catch (e) {
			console.warn("Failed to hydrate attachment content", e);
			return att;
		}
	}

	private async hydrateAttachmentsForRequest(
		attachments: NonNullable<Message["attachments"]>,
		options: { sessionId?: string | null; shareToken?: string | null },
	): Promise<NonNullable<Message["attachments"]>> {
		const sessionId = options.sessionId ?? null;
		const shareToken = options.shareToken ?? null;
		if (!sessionId && !shareToken) return attachments;
		return await Promise.all(
			attachments.map((att) => this.hydrateAttachmentForRequest(att, options)),
		);
	}

	private async buildMessagesForChatRequest(
		messages: UiMessage[],
	): Promise<Message[]> {
		const sessionId = this.currentSessionId;
		const shareToken = this.shareToken;
		const filtered = messages.filter((msg) => !msg.localOnly);
		if (!sessionId && !shareToken) return filtered;

		const out: Message[] = [];
		for (const msg of filtered) {
			const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
			if (msg.role !== "user" || atts.length === 0) {
				out.push(msg);
				continue;
			}

			const hydrated = await this.hydrateAttachmentsForRequest(atts, {
				sessionId,
				shareToken,
			});
			out.push({ ...msg, attachments: hydrated });
		}
		return out;
	}

	private async handleSubmit(
		event: CustomEvent<{
			text: string;
			retry?: boolean;
			attachments?: Message["attachments"];
		}>,
	) {
		const text = event.detail.text.trim();
		const attachments =
			Array.isArray(event.detail.attachments) && event.detail.attachments.length
				? event.detail.attachments
				: undefined;
		if ((!text && !attachments) || this.loading || !this.clientOnline) {
			return;
		}
		this.lastSendFailed = null;
		this.lastApiError = null;

		if (!event.detail.retry && this.isSlashCommand(text)) {
			await this.handleSlashCommand(text, attachments);
			return;
		}

		if (this.shareToken) {
			this.showToast("Shared sessions are read-only", "info", 1800);
			return;
		}

		const enrichedAttachments = attachments
			? await this.ensureExtractedTextForAttachments(attachments)
			: undefined;

		// Add user message unless reusing the existing one for a retry
		if (!event.detail.retry) {
			const userMessage: Message = {
				role: "user",
				content: text,
				attachments: enrichedAttachments,
				timestamp: new Date().toISOString(),
			};
			this.messages = [...this.messages, userMessage];
		}

		// Start loading
		this.loading = true;
		this.error = null;
		this.runtimeStatus = null;

		// Add assistant message placeholder
		const assistantMessage: UiMessage = {
			role: "assistant",
			content: "",
			timestamp: new Date().toISOString(),
			tools: [],
			thinking: "",
		};
		this.messages = [...this.messages, assistantMessage];

		// Ensure the user sees the newly appended messages immediately, and keep the
		// rendered window anchored to the bottom while streaming.
		this.autoScroll = true;
		this.unseenMessages = 0;
		this.renderEndIndex = this.messages.length;
		this.lastMessagesLength = this.messages.length;
		this.scrollToBottom({ force: true });

		// Track active tool calls
		const activeTools = new Map<string, ActiveToolInfo>();
		const toolCallJsonById = new Map<string, string>();
		const toolCallArgsById = new Map<string, Record<string, unknown>>();
		const thinkingBlocks = new Map<number, string>();
		let currentThinkingIndex: number | null = null;
		let terminalStreamOutcome: ReturnType<typeof getTerminalStreamOutcome> =
			null;
		let sessionIdDuringStream: string | null = this.currentSessionId;
		let recoveredPendingSessionRequests = false;
		const recoverPendingSessionRequestsOnce = async () => {
			if (recoveredPendingSessionRequests) {
				return;
			}
			recoveredPendingSessionRequests = true;
			await this.recoverPendingSessionRequests(sessionIdDuringStream);
		};

		try {
			if (!this.currentSessionId) {
				const session = await this.apiClient.createSession("New Chat");
				sessionIdDuringStream = session.id;
				this.currentSessionId = session.id;
				this.requestUpdate();
			}

			const requestMessages = await this.buildMessagesForChatRequest(
				this.messages.slice(0, -1), // Exclude placeholder
			);

			// Stream response with FULL events
			const stream = this.apiClient.chatWithEvents({
				model: this.currentModel,
				messages: requestMessages,
				sessionId: this.currentSessionId || undefined,
			});

			for await (const agentEvent of stream) {
				// Handle different event types
				switch (agentEvent.type) {
					case "session_update":
						if (agentEvent.sessionId) {
							sessionIdDuringStream = agentEvent.sessionId;
							this.currentSessionId = agentEvent.sessionId;
							this.requestUpdate();
							void this.refreshUiState(agentEvent.sessionId);
						}
						break;
					case "message_update":
						if (agentEvent.assistantMessageEvent) {
							const msgEvent = agentEvent.assistantMessageEvent;

							// Text deltas
							if (msgEvent.type === "text_delta") {
								if (typeof assistantMessage.content !== "string") {
									assistantMessage.content = this.coerceMessageContent(
										assistantMessage.content,
									);
								}
								assistantMessage.content += msgEvent.delta;
								this.messages = [...this.messages];
							}

							// Thinking deltas
							else if (msgEvent.type === "thinking_start") {
								currentThinkingIndex = msgEvent.contentIndex;
								thinkingBlocks.set(msgEvent.contentIndex, "");
							} else if (
								msgEvent.type === "thinking_delta" &&
								currentThinkingIndex !== null
							) {
								const current = thinkingBlocks.get(currentThinkingIndex) || "";
								thinkingBlocks.set(
									currentThinkingIndex,
									current + msgEvent.delta,
								);
								assistantMessage.thinking = Array.from(
									thinkingBlocks.values(),
								).join("\n\n");
								this.messages = [...this.messages];
							} else if (msgEvent.type === "thinking_end") {
								currentThinkingIndex = null;
							}

							// Tool call tracking
							else if (msgEvent.type === "toolcall_start") {
								const partial = Array.isArray(msgEvent.partial?.content)
									? msgEvent.partial?.content[msgEvent.contentIndex]
									: undefined;
								const slimArgs =
									msgEvent.toolCallArgs &&
									typeof msgEvent.toolCallArgs === "object" &&
									!Array.isArray(msgEvent.toolCallArgs)
										? (msgEvent.toolCallArgs as Record<string, unknown>)
										: undefined;
								const argsTruncated = Boolean(msgEvent.toolCallArgsTruncated);
								const toolCallId =
									partial?.type === "toolCall"
										? partial.id
										: msgEvent.toolCallId;
								if (toolCallId) {
									if (slimArgs) {
										toolCallArgsById.set(toolCallId, slimArgs);
									}
									const args =
										partial?.type === "toolCall"
											? (partial.arguments ?? {})
											: (slimArgs ?? toolCallArgsById.get(toolCallId) ?? {});
									const name =
										partial?.type === "toolCall"
											? partial.name || "tool"
											: msgEvent.toolCallName || "tool";
									if (!assistantMessage.tools) assistantMessage.tools = [];
									const existingIndex = assistantMessage.tools.findIndex(
										(t) => t.toolCallId === toolCallId,
									);
									const entry: ExtendedToolCall = {
										toolCallId,
										name,
										status: "pending",
										args,
										argsTruncated,
										startTime: Date.now(),
									};
									if (existingIndex >= 0) {
										assistantMessage.tools[existingIndex] = {
											...assistantMessage.tools[existingIndex],
											...entry,
										};
									} else {
										assistantMessage.tools.push(entry);
									}
									activeTools.set(toolCallId, {
										name,
										args,
										index:
											existingIndex >= 0
												? existingIndex
												: assistantMessage.tools.length - 1,
										argsTruncated,
									});
									this.messages = [...this.messages];
								}
							} else if (msgEvent.type === "toolcall_delta") {
								const partial = Array.isArray(msgEvent.partial?.content)
									? msgEvent.partial?.content[msgEvent.contentIndex]
									: undefined;
								const slimArgs =
									msgEvent.toolCallArgs &&
									typeof msgEvent.toolCallArgs === "object" &&
									!Array.isArray(msgEvent.toolCallArgs)
										? (msgEvent.toolCallArgs as Record<string, unknown>)
										: undefined;
								const argsTruncated = Boolean(msgEvent.toolCallArgsTruncated);
								const toolCallId =
									partial?.type === "toolCall"
										? partial.id
										: msgEvent.toolCallId;
								if (toolCallId) {
									let args: Record<string, unknown>;
									if (partial?.type === "toolCall") {
										args = partial.arguments ?? {};
									} else if (slimArgs) {
										toolCallArgsById.set(toolCallId, slimArgs);
										args = slimArgs;
									} else if (argsTruncated) {
										args = toolCallArgsById.get(toolCallId) ?? {};
									} else {
										const current = toolCallJsonById.get(toolCallId) ?? "";
										const next = current + msgEvent.delta;
										toolCallJsonById.set(toolCallId, next);
										const parsed = parseToolCallArgs(next);
										if (parsed) {
											toolCallArgsById.set(toolCallId, parsed);
											args = parsed;
										} else {
											args = toolCallArgsById.get(toolCallId) ?? {};
										}
									}
									if (!assistantMessage.tools) assistantMessage.tools = [];
									const existingIndex = assistantMessage.tools.findIndex(
										(t) => t.toolCallId === toolCallId,
									);
									if (existingIndex >= 0) {
										const existingTool = assistantMessage.tools[existingIndex]!;
										assistantMessage.tools[existingIndex] = {
											...existingTool,
											args,
											status: "pending",
											argsTruncated:
												existingTool.argsTruncated || argsTruncated,
										};
									} else {
										assistantMessage.tools.push({
											toolCallId,
											name:
												partial?.type === "toolCall"
													? partial.name || "tool"
													: msgEvent.toolCallName || "tool",
											status: "pending",
											args,
											argsTruncated,
										});
									}
									activeTools.set(toolCallId, {
										name:
											partial?.type === "toolCall"
												? partial.name || "tool"
												: msgEvent.toolCallName || "tool",
										args,
										index:
											existingIndex >= 0
												? existingIndex
												: assistantMessage.tools.length - 1,
										argsTruncated,
									});
									this.messages = [...this.messages];
								}
							} else if (msgEvent.type === "toolcall_end") {
								const toolCall = msgEvent.toolCall;
								toolCallJsonById.delete(toolCall.id);
								toolCallArgsById.delete(toolCall.id);
								if (!assistantMessage.tools) assistantMessage.tools = [];
								const existingIndex = assistantMessage.tools.findIndex(
									(t) => t.toolCallId === toolCall.id,
								);
								const extendedTool: ExtendedToolCall = {
									toolCallId: toolCall.id,
									name: toolCall.name,
									status: "pending",
									args: toolCall.arguments,
									argsTruncated: false,
								};
								if (existingIndex >= 0) {
									assistantMessage.tools[existingIndex] = {
										...assistantMessage.tools[existingIndex],
										...extendedTool,
									};
								} else {
									assistantMessage.tools.push(extendedTool);
								}
								activeTools.set(toolCall.id, {
									name: toolCall.name,
									args: toolCall.arguments,
									index:
										existingIndex >= 0
											? existingIndex
											: assistantMessage.tools.length - 1,
								});
								this.messages = [...this.messages];
							}
						}
						break;

					case "tool_execution_start": {
						// Update tool status to running
						const toolInfo = activeTools.get(agentEvent.toolCallId);
						if (toolInfo && assistantMessage.tools) {
							const tool = assistantMessage.tools[
								toolInfo.index
							] as ExtendedToolCall;
							tool.status = "running";
							tool.startTime = Date.now();
							tool.displayName = agentEvent.displayName ?? tool.displayName;
							tool.summaryLabel = agentEvent.summaryLabel ?? tool.summaryLabel;
							this.messages = [...this.messages];
						}
						break;
					}

					case "tool_execution_update": {
						const toolInfo = activeTools.get(agentEvent.toolCallId);
						if (toolInfo && assistantMessage.tools) {
							const tool = assistantMessage.tools[
								toolInfo.index
							] as ExtendedToolCall;
							tool.result = agentEvent.partialResult;
							tool.displayName = agentEvent.displayName ?? tool.displayName;
							tool.summaryLabel = agentEvent.summaryLabel ?? tool.summaryLabel;
							this.messages = [...this.messages];
						}
						break;
					}

					case "tool_execution_end": {
						// Update tool with result
						const completedTool = activeTools.get(agentEvent.toolCallId);
						if (completedTool && assistantMessage.tools) {
							const tool = assistantMessage.tools[
								completedTool.index
							] as ExtendedToolCall;
							tool.status = agentEvent.isError ? "error" : "completed";
							tool.result = agentEvent.result;
							tool.endTime = Date.now();
							tool.displayName = agentEvent.displayName ?? tool.displayName;
							tool.summaryLabel = agentEvent.summaryLabel ?? tool.summaryLabel;
							this.messages = [...this.messages];
						}
						activeTools.delete(agentEvent.toolCallId);
						break;
					}

					case "status":
					case "compaction":
					case "tool_batch_summary": {
						const nextRuntimeStatus = formatWebRuntimeStatus(agentEvent);
						if (nextRuntimeStatus) {
							this.runtimeStatus = nextRuntimeStatus;
						}
						break;
					}

					case "action_approval_required": {
						this.enqueueApprovalRequest(agentEvent.request);
						break;
					}

					case "action_approval_resolved": {
						this.clearApprovalRequest(agentEvent.request.id);
						break;
					}

					case "tool_retry_required": {
						this.enqueueToolRetryRequest(agentEvent.request);
						break;
					}

					case "tool_retry_resolved": {
						this.clearToolRetryRequest(agentEvent.request.id);
						break;
					}

					case "client_tool_request": {
						await this.handleClientToolRequest(
							agentEvent.toolCallId,
							agentEvent.toolName,
							agentEvent.args,
						);
						break;
					}

					case "message_end":
						// Finalize assistant message
						if (agentEvent.message.role === "assistant") {
							assistantMessage.timestamp = new Date().toISOString();
							this.messages = [...this.messages];
						}
						break;

					case "error":
					case "aborted":
						terminalStreamOutcome = getTerminalStreamOutcome(agentEvent);
						break;

					case "agent_end":
						terminalStreamOutcome ??= getTerminalStreamOutcome(agentEvent);
						break;
				}

				if (this.autoScroll) this.scrollToBottom();
			}

			if (terminalStreamOutcome) {
				if (terminalStreamOutcome.type === "error") {
					await recoverPendingSessionRequestsOnce();
				}
				this.error = terminalStreamOutcome.message;
				this.lastSendFailed = text;
				this.lastApiError = terminalStreamOutcome.message;
				if (!hasAssistantMessageProgress(assistantMessage)) {
					this.messages = this.messages.slice(0, -1);
				} else {
					assistantMessage.timestamp ||= new Date().toISOString();
					this.messages = [...this.messages];
				}
				this.showToast(
					terminalStreamOutcome.message,
					terminalStreamOutcome.type,
				);
			}

			this.runtimeStatus = null;

			// Refresh sessions list
			await this.loadSessions();
		} catch (e) {
			await recoverPendingSessionRequestsOnce();
			if (sessionIdDuringStream) {
				await this.loadSessions();
			}
			this.error = e instanceof Error ? e.message : "Failed to send message";
			this.runtimeStatus = null;
			if (!hasAssistantMessageProgress(assistantMessage)) {
				this.messages = this.messages.slice(0, -1);
			} else {
				assistantMessage.timestamp ||= new Date().toISOString();
				this.messages = [...this.messages];
			}
			this.showToast(this.error, "error");
			this.lastSendFailed = text;
			this.lastApiError = this.error;
		} finally {
			this.loading = false;
		}
	}

	private async runJavascriptRepl(args: unknown): Promise<{
		isError: boolean;
		text: string;
	}> {
		const obj = (
			args && typeof args === "object" ? (args as Record<string, unknown>) : {}
		) as Record<string, unknown>;
		const code = typeof obj.code === "string" ? obj.code : "";
		const timeoutMs =
			typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs)
				? obj.timeoutMs
				: 10_000;

		if (!code.trim()) {
			return { isError: true, text: "Error: javascript_repl requires code" };
		}

		const sandboxId = `repl:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

		let settled = false;
		let returnValue: string | null = null;
		const errorState: { value: { message: string; stack?: string } | null } = {
			value: null,
		};

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});

		const consumer = {
			handleMessage: async (message: unknown) => {
				if (settled || !message || typeof message !== "object") return;
				const m = message as Record<string, unknown>;
				if (m.type === "execution-complete") {
					settled = true;
					returnValue =
						typeof m.returnValue === "string"
							? m.returnValue
							: String(m.returnValue ?? "");
					resolveDone();
				}
				if (m.type === "execution-error") {
					settled = true;
					const err = m.error;
					if (err && typeof err === "object") {
						const rec = err as Record<string, unknown>;
						errorState.value = {
							message:
								typeof rec.message === "string"
									? rec.message
									: "Execution error",
							stack: typeof rec.stack === "string" ? rec.stack : undefined,
						};
					} else {
						errorState.value = { message: "Execution error" };
					}
					resolveDone();
				}
			},
		};

		const el = document.createElement(
			"composer-sandboxed-iframe",
		) as HTMLElement & {
			sandboxId: string;
			htmlContent: string;
			providers: unknown[];
			consumers: unknown[];
		};

		el.style.position = "fixed";
		el.style.left = "-99999px";
		el.style.top = "-99999px";
		el.style.width = "1px";
		el.style.height = "1px";
		el.style.opacity = "0";
		el.style.pointerEvents = "none";

		el.sandboxId = sandboxId;
		el.htmlContent = "<!doctype html><html><body></body></html>";

		const artifactsProvider = new ArtifactsRuntimeProvider(
			() => this.getArtifactsList(),
			{
				createOrUpdate: async (filename, content) => {
					const exists = this.artifactsState.byFilename.has(filename);
					const cmd = exists ? "rewrite" : "create";
					const res = applyArtifactsCommand(this.artifactsState, {
						command: cmd,
						filename,
						content,
					});
					this.artifactsState = res.state;
					if (!res.isError) {
						this.setActiveArtifact(filename);
					}
				},
				delete: async (filename) => {
					const res = applyArtifactsCommand(this.artifactsState, {
						command: "delete",
						filename,
					});
					this.artifactsState = res.state;
					if (this.activeArtifact === filename) {
						this.activeArtifact = null;
					}
				},
			},
		);

		const attachmentsForSandbox = await (async () => {
			const list = this.getAllAttachments();
			const sessionId = this.currentSessionId;
			const shareToken = this.shareToken;
			return await this.hydrateAttachmentsForRequest(list, {
				sessionId,
				shareToken,
			});
		})();

		el.providers = [
			artifactsProvider,
			new AttachmentsRuntimeProvider(
				attachmentsForSandbox
					.filter((a) => typeof a.content === "string" && a.content.length > 0)
					.map((a) => ({
						id: a.id,
						fileName: a.fileName,
						mimeType: a.mimeType,
						size: a.size,
						content: a.content as string,
						extractedText: a.extractedText,
					})),
			),
			new FileDownloadRuntimeProvider(),
			new JavascriptReplRuntimeProvider(code, { timeoutMs }),
		];
		el.consumers = [consumer];

		document.body.appendChild(el);

		const hardTimeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			errorState.value = { message: "Execution timed out" };
			resolveDone();
		}, timeoutMs + 200);

		try {
			await done;
		} finally {
			window.clearTimeout(hardTimeout);
			try {
				el.remove();
			} catch {
				// ignore
			}
		}

		const snap = getSandboxConsoleSnapshot(sandboxId);
		const logs = snap?.logs ?? [];
		const lastError = snap?.lastError ?? null;
		const downloads = getSandboxDownloadsSnapshot(sandboxId)?.files ?? [];

		const lines: string[] = [];
		if (errorState.value) {
			lines.push(`Error: ${errorState.value.message}`);
			if (errorState.value.stack) lines.push(errorState.value.stack);
		} else if (returnValue !== null) {
			lines.push("Return value:");
			lines.push(returnValue);
		} else {
			lines.push("No return value.");
		}

		if (logs.length > 0) {
			lines.push("", "Console:");
			for (const l of logs) {
				lines.push(`[${l.level}] ${l.text}`);
			}
		}

		if (!errorState.value && lastError) {
			lines.push("", "Last error:");
			lines.push(lastError.message);
			if (lastError.stack) lines.push(lastError.stack);
		}

		if (downloads.length > 0) {
			lines.push("", "Downloads:");
			for (const f of downloads) {
				lines.push(`- ${f.fileName} (${f.mimeType})`);
			}
		}

		return {
			isError: Boolean(errorState.value),
			text: lines.filter(Boolean).join("\n"),
		};
	}

	private async runMcpClientTool(
		toolName: string,
		args: unknown,
	): Promise<{ isError: boolean; text: string }> {
		const argRecord = coerceToolArgsRecord(args);

		if (toolName === "read_mcp_resource") {
			const server = getOptionalStringArg(argRecord, "server");
			const uri = getOptionalStringArg(argRecord, "uri");
			if (!server || !uri) {
				return {
					isError: true,
					text: "Error: read_mcp_resource requires server and uri",
				};
			}

			const result = await this.apiClient.readMcpResource(server, uri);
			return {
				isError: false,
				text: formatMcpResourceRead(result, uri),
			};
		}

		if (toolName === "get_mcp_prompt") {
			const server = getOptionalStringArg(argRecord, "server");
			const name = getOptionalStringArg(argRecord, "name");
			const promptArgs =
				argRecord.args &&
				typeof argRecord.args === "object" &&
				!Array.isArray(argRecord.args)
					? Object.fromEntries(
							Object.entries(argRecord.args as Record<string, unknown>).filter(
								([, value]) => typeof value === "string",
							),
						)
					: undefined;
			if (!server || !name) {
				return {
					isError: true,
					text: "Error: get_mcp_prompt requires server and name",
				};
			}

			const result = await this.apiClient.getMcpPrompt(
				server,
				name,
				promptArgs,
			);
			return {
				isError: false,
				text: formatMcpPrompt(result, name),
			};
		}

		const status = await this.apiClient.getMcpStatus();
		if (toolName === "list_mcp_servers") {
			return {
				isError: false,
				text: formatMcpServers(status),
			};
		}
		if (toolName === "list_mcp_tools") {
			return formatMcpTools(status, getOptionalStringArg(argRecord, "server"));
		}
		if (toolName === "list_mcp_resources") {
			return formatMcpResources(
				status,
				getOptionalStringArg(argRecord, "server"),
			);
		}
		if (toolName === "list_mcp_prompts") {
			return formatMcpPrompts(
				status,
				getOptionalStringArg(argRecord, "server"),
			);
		}

		return {
			isError: true,
			text: `Unsupported MCP client tool: ${toolName}`,
		};
	}

	private retryLastSend = () => {
		if (!this.lastSendFailed) return;
		this.handleSubmit(
			new CustomEvent("submit", {
				detail: { text: this.lastSendFailed, retry: true },
			}),
		);
	};

	private scrollToBottom(options?: { force?: boolean }) {
		if (!options?.force && !this.autoScroll) return;
		this.updateComplete.then(() => {
			const messagesEl = this.getMessagesScroller();
			if (!messagesEl) return;
			messagesEl.scrollTop = messagesEl.scrollHeight;
			this.updateVirtualWindow();
		});
	}

	private getArtifactsList(): Artifact[] {
		return Array.from(this.artifactsState.byFilename.values()).sort((a, b) =>
			a.filename.localeCompare(b.filename),
		);
	}

	private getAllAttachments(): NonNullable<Message["attachments"]> {
		const byId = new Map<string, NonNullable<Message["attachments"]>[number]>();

		for (const msg of this.messages) {
			if (msg.role !== "user") continue;
			const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
			for (const a of attachments) {
				if (!a || typeof a !== "object") continue;
				const id = typeof a.id === "string" ? a.id : "";
				if (!id) continue;

				const existing = byId.get(id);
				if (!existing) {
					byId.set(id, a);
					continue;
				}

				byId.set(id, {
					...existing,
					...a,
					content: a.content ?? existing.content,
					preview: a.preview ?? existing.preview,
					extractedText: a.extractedText ?? existing.extractedText,
				});
			}
		}

		return Array.from(byId.values()).map((a) => {
			if (typeof a.content === "string" && a.content.length > 0) return a;
			if (!a.contentOmitted) return a;
			const cached = this.attachmentContentCache.get(a.id);
			return cached ? { ...a, content: cached, contentOmitted: undefined } : a;
		});
	}

	private formatSessionDate(date: string): string {
		const d = new Date(date);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) return "Today";
		if (days === 1) return "Yesterday";
		if (days < 7) return `${days} days ago`;
		return d.toLocaleDateString();
	}

	private refreshStatus() {
		const now = Date.now();
		if (now < this.nextRefreshAllowed) {
			this.showToast("Refresh throttled, try again shortly", "info", 1500);
			return;
		}
		this.nextRefreshAllowed = now + 3000; // 3s debounce
		dataStore.ensureStatus(this.apiClient, true);
		dataStore.ensureModels(this.apiClient, true);
		dataStore.ensureUsage(this.apiClient, true);
		void this.loadApprovalModeStatus();
		this.showToast("Refreshing API state", "info", 1200);
	}

	private showToast(
		message: string,
		type: "info" | "error" | "success" = "info",
		duration = 3200,
	) {
		this.toast = { message, type };
		setTimeout(() => {
			if (this.toast?.message === message) {
				this.toast = null;
			}
		}, duration);
	}

	override render() {
		const cwd = this.status?.cwd || "unknown";
		const gitBranch = this.status?.git?.branch || "unknown";
		const gitStatus = this.status?.git?.status;
		const gitSummary = gitStatus
			? [
					gitStatus.modified ? `${gitStatus.modified} mod` : null,
					gitStatus.added ? `${gitStatus.added} add` : null,
					gitStatus.deleted ? `${gitStatus.deleted} del` : null,
					gitStatus.untracked ? `${gitStatus.untracked} untracked` : null,
				]
					.filter(Boolean)
					.join(", ")
			: "n/a";
		const totalCost =
			this.usage && typeof this.usage.totalCost === "number"
				? this.usage.totalCost > 0
					? `$${this.usage.totalCost.toFixed(2)}`
					: null
				: null;
		const isOnline = Boolean(this.status) && this.clientOnline;
		const latency = this.status?.lastLatencyMs || null;
		const taskHealth = this.status?.backgroundTasks;
		const taskRunning = taskHealth?.running ?? 0;
		const taskFailed = taskHealth?.failed ?? 0;
		const isShared = Boolean(this.shareToken);
		const approvalPillClass =
			this.approvalMode === "auto"
				? "success"
				: this.approvalMode === "fail"
					? "error"
					: "warning";
		const approvalTitle =
			this.approvalModeNotice ??
			(this.approvalMode
				? `Approval mode: ${this.approvalMode}`
				: "Approval mode");
		const showSessionGallery =
			!isShared && this.messages.length === 0 && this.sessions.length > 0;
		const hasMessages = this.messages.length > 0;
		const {
			start: windowStart,
			end: windowEnd,
			total: totalMessages,
		} = this.getRenderWindow();
		const visibleMessages = this.messages.slice(windowStart, windowEnd);
		const shouldVirtualize =
			windowEnd - windowStart >= ComposerChat.VIRTUALIZATION_MIN_MESSAGES;
		const resolvedVirtualStart =
			this.virtualStartIndex >= windowStart &&
			this.virtualStartIndex < windowEnd
				? this.virtualStartIndex
				: windowStart;
		const resolvedVirtualEnd =
			this.virtualEndIndex > resolvedVirtualStart &&
			this.virtualEndIndex <= windowEnd
				? this.virtualEndIndex
				: windowEnd;
		const virtualStartLocal = Math.max(0, resolvedVirtualStart - windowStart);
		const virtualEndLocal = Math.max(
			virtualStartLocal,
			resolvedVirtualEnd - windowStart,
		);
		const virtualMessages = shouldVirtualize
			? visibleMessages.slice(virtualStartLocal, virtualEndLocal)
			: visibleMessages;
		const visibleCount = visibleMessages.length;
		const hiddenOldCount = windowStart;
		const hiddenNewCount = totalMessages - windowEnd;
		const renderedMessages = virtualMessages.map((msg, idx) => {
			const globalIndex = shouldVirtualize
				? resolvedVirtualStart + idx
				: windowStart + idx;
			const isStreaming =
				this.loading &&
				globalIndex === this.messages.length - 1 &&
				msg.role === "assistant";
			return html`
				<composer-message
					data-index=${globalIndex}
					role=${msg.role}
					content=${msg.content}
					timestamp=${msg.timestamp || ""}
					.attachments=${msg.attachments || []}
					.thinking=${(msg as MessageWithThinking).thinking || ""}
					.tools=${msg.tools || []}
					.toolSummaryLabels=${summarizeWebToolCalls(msg.tools || [])}
					.cleanMode=${this.cleanMode}
					.streaming=${isStreaming}
					.compact=${this.compactMode}
					.reducedMotion=${this.reducedMotion}
				></composer-message>
			`;
		});
		const topSpacer =
			shouldVirtualize && this.virtualPaddingTop > 0
				? html`<div
						class="virtual-spacer"
						style="height: ${this.virtualPaddingTop}px"
					></div>`
				: "";
		const bottomSpacer =
			shouldVirtualize && this.virtualPaddingBottom > 0
				? html`<div
						class="virtual-spacer"
						style="height: ${this.virtualPaddingBottom}px"
					></div>`
				: "";
		const recentSessions = showSessionGallery ? this.sessions.slice(0, 8) : [];
		const sessionLoading = this.loading && this.messages.length === 0;
		const lastUpdated = this.status?.lastUpdated ?? null;

		const healthClass = !isOnline
			? "error"
			: latency !== null
				? latency > 1000
					? "warning"
					: "success"
				: "";
		const latencyLabel =
			latency === null
				? "n/a"
				: latency > 1000
					? "slow"
					: latency > 400
						? "ok"
						: "fast";
		const activeApprovalRequest = this.pendingApprovalQueue[0] ?? null;
		const activeToolRetryRequest =
			activeApprovalRequest === null
				? (this.pendingToolRetryQueue[0] ?? null)
				: null;
		const activeMcpElicitationRequest =
			activeApprovalRequest === null && activeToolRetryRequest === null
				? (this.pendingMcpElicitationQueue[0] ?? null)
				: null;
		const activeUserInputRequest =
			activeApprovalRequest === null &&
			activeToolRetryRequest === null &&
			activeMcpElicitationRequest === null
				? (this.pendingUserInputQueue[0] ?? null)
				: null;

		return html`
			<composer-approval
				.request=${activeApprovalRequest}
				.submitting=${this.approvalSubmitting}
				.queueLength=${this.pendingApprovalQueue.length}
				@approve=${this.handleApproveRequest}
				@deny=${this.handleDenyRequest}
			></composer-approval>
			<composer-tool-retry
				.request=${activeToolRetryRequest}
				.submitting=${this.toolRetrySubmitting}
				.queueLength=${this.pendingToolRetryQueue.length}
				@retry=${this.handleRetryRequest}
				@skip=${this.handleSkipRetryRequest}
				@abort=${this.handleAbortRetryRequest}
			></composer-tool-retry>
			<composer-mcp-elicitation
				.request=${activeMcpElicitationRequest}
				.submitting=${this.mcpElicitationSubmitting}
				.queueLength=${this.pendingMcpElicitationQueue.length}
				@submit-response=${this.handleSubmitMcpElicitationRequest}
				@cancel=${this.handleCancelMcpElicitationRequest}
			></composer-mcp-elicitation>
			<composer-user-input
				.request=${activeUserInputRequest}
				.submitting=${this.userInputSubmitting}
				.queueLength=${this.pendingUserInputQueue.length}
				@submit-response=${this.handleSubmitUserInputRequest}
				@cancel=${this.handleCancelUserInputRequest}
			></composer-user-input>
			<composer-attachment-viewer
				.open=${this.attachmentViewerOpen}
				.attachment=${this.attachmentViewerAttachment}
				.apiClient=${this.apiClient}
				.apiEndpoint=${this.apiClient?.baseUrl || this.apiEndpoint}
				.sessionId=${isShared ? null : this.currentSessionId}
				.shareToken=${this.shareToken}
				@attachment-updated=${this.handleAttachmentUpdated}
				@close=${this.closeAttachmentViewer}
			></composer-attachment-viewer>
			${
				isShared
					? html`<div class="banner info">
							Shared session — read-only.
							<button
								class="icon-btn"
								@click=${async () => {
									try {
										await navigator.clipboard.writeText(window.location.href);
										this.showToast("Link copied", "success", 1500);
									} catch {
										this.showToast("Copy failed", "error", 1500);
									}
								}}
							>
								Copy link
							</button>
						</div>`
					: ""
			}
			${
				!this.clientOnline
					? html`<div class="banner offline">Offline detected — messages will pause until connection returns.</div>`
					: ""
			}
			${
				this.lastSendFailed
					? html`<div class="banner retry">
						Last send failed.
						<button class="icon-btn" @click=${this.retryLastSend}>Retry</button>
					</div>`
					: ""
			}
			${
				this.sidebarOpen
					? html`<div
							class="sidebar-overlay active"
							@click=${() => {
								this.sidebarOpen = false;
							}}
						></div>`
					: ""
			}
			<composer-session-sidebar
				?shared=${isShared}
				?collapsed=${!this.sidebarOpen}
				.sessions=${this.sessions}
				.currentSessionId=${this.currentSessionId}
				@new-session=${this.createNewSession}
				@select-session=${this.handleSelectSession}
				@update-session=${this.handleUpdateSession}
				@delete-session=${this.handleDeleteSession}
				@exit-shared=${this.handleExitSharedSession}
			></composer-session-sidebar>

			<div class="main-content">
		<div class="header">
			<div class="header-left">
				<button class="toggle-sidebar-btn" @click=${this.toggleSidebar} title=${this.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
					${this.sidebarOpen ? this.renderIcon("chevron-left") : this.renderIcon("chevron-right")}
				</button>
				<h1>Maestro</h1>
			</div>
			<div class="status-bar">
						<div class="status-item active">
							<span class="status-dot ${isOnline ? "" : "offline"} ${healthClass}"></span>
							<span>${isOnline ? "ONLINE" : "OFFLINE"}</span>
							${
								this.status?.server?.uptime
									? html`<span class="muted">${Math.max(1, Math.floor(this.status.server.uptime / 60))}m</span>`
									: ""
							}
							${
								latency
									? html`<span class="muted" title=${latencyLabel}>${Math.round(latency)}ms</span>`
									: ""
							}
							<button class="icon-btn" title="API health" @click=${this.toggleHealth}>${this.renderIcon("info")}</button>
						</div>
						<div class="status-item">
							<span>CWD</span>
							<span class="pill">${cwd.split("/").pop()}</span>
						</div>
						${
							this.status?.git
								? html`<div class="status-item" title=${gitSummary}>
									<span>GIT</span>
									<span class="pill ${this.status.git.status.modified || this.status.git.status.added || this.status.git.status.deleted ? "warning" : "success"}">${gitBranch}</span>
								</div>`
								: ""
						}
						${
							!isShared && this.approvalMode
								? html`<div class="status-item" title=${approvalTitle}>
									<span>APPROVALS</span>
									<span class="pill ${approvalPillClass}">${this.approvalMode}</span>
									${
										this.approvalModeNotice
											? html`<span class="status-note">locked</span>`
											: ""
									}
								</div>`
								: ""
						}
						${
							taskHealth
								? html`<div class="status-item" title="Background tasks">
									<span>TASKS</span>
									<span class="pill ${taskFailed > 0 ? "warning" : "success"}">
										${taskRunning} running${taskFailed > 0 ? ` · ${taskFailed} failed` : ""}
									</span>
								</div>`
								: ""
						}
						<div class="status-item">
							<span>MSGS</span>
							<span class="muted">${this.messages.length}</span>
						</div>
						${
							this.runtimeStatus
								? html`<div class="status-item runtime-status" title="Current agent runtime status">
										<span>AGENT</span>
										<span class="pill info">${this.runtimeStatus}</span>
									</div>`
								: ""
						}
						<button class="icon-btn" title="Refresh status" @click=${this.refreshStatus}>${this.renderIcon("refresh")}</button>
						${
							lastUpdated
								? html`<span class="status-item" title="Last API refresh">
										<span>UPDATED</span>
										<span class="muted">${new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
									</span>`
								: ""
						}
			</div>
			<div class="header-right">
				<div class="model-selector" @click=${this.openModelSelector}>
					<span class="model-badge">AI</span>
					<span>${this.currentModel.split("/").pop()?.toUpperCase() || "MODEL"}</span>
						</div>
						<button class="icon-btn" title="Choose Model" @click=${this.openModelSelector}>${this.renderIcon("globe")}</button>
						<button
							class="icon-btn"
							title=${isShared ? "Shared sessions are read-only" : "Share session"}
							@click=${this.openShareDialog}
							?disabled=${isShared || !this.currentSessionId}
						>
							${this.renderIcon("share")}
						</button>
						<button
							class="icon-btn"
							title=${isShared ? "Shared sessions are read-only" : "Export session"}
							@click=${this.openExportDialog}
							?disabled=${isShared || !this.currentSessionId}
						>
							⤓
						</button>
						<button
							class="icon-btn"
							title="Toggle theme"
							@click=${this.toggleTheme}
						>
							${this.renderIcon(this.theme === "dark" ? "sun" : "moon")}
						</button>
						<button class="icon-btn" title="Settings" @click=${this.toggleSettings}>${this.renderIcon("settings")}</button>
						${
							this.hasAdminSettingsAccess()
								? html`<button class="icon-btn" title="Admin Settings" @click=${this.toggleAdminSettings}>🛡️</button>`
								: null
						}
						<button
							class="icon-btn ${this.artifactsOpen ? "active" : ""}"
							title=${isShared ? "Artifacts (read-only)" : "Artifacts"}
							@click=${this.toggleArtifactsPanel}
						>
							${this.renderIcon("file")}
						</button>
						<button class="icon-btn ${this.compactMode ? "active" : ""}" title="Toggle compact layout (Ctrl/Cmd+M)" @click=${this.toggleCompact}>${this.renderIcon("grid")}</button>
						<button class="icon-btn ${this.reducedMotion ? "active" : ""}" title="Toggle reduced motion" @click=${this.toggleReducedMotion}>${this.renderIcon("reduce")}</button>
					</div>
				</div>

				${this.error ? html`<div class="error">${this.error}</div>` : ""}

				<div
					class="messages ${this.compactMode ? "compact" : ""}"
					@open-artifact=${this.handleOpenArtifact}
				>
						${
							this.messages.length === 0
								? html`
									<div class="empty-state">
										${
											sessionLoading
												? html`<div class="loading">Loading session...</div>`
												: ""
										}
										<div class="workspace-panel">
										<div class="panel-section">
											<h3>Workspace</h3>
											<div class="panel-item active">
												<span>►</span>${cwd}
											</div>
											<div class="panel-item">
												<span>GIT:</span>${gitBranch}
											</div>
											<div class="panel-item">
												<span>FILES:</span>${gitSummary}
											</div>
										</div>
											<div class="panel-section">
												<h3>Model</h3>
												<div class="panel-item active">
													<span>►</span>${this.currentModel}
												</div>
												<div class="panel-item">
												<span>CTX:</span>${this.currentModelTokens ?? "loading…"}
												</div>
												<div class="panel-item">
													<span>MODE:</span>streaming
												</div>
											</div>
										<div class="panel-section">
											<h3>Session</h3>
											<div class="panel-item">
												<span>ID:</span>${this.currentSessionId?.slice(0, 8) || "new"}
											</div>
											<div class="panel-item">
												<span>MSGS:</span>0
											</div>
											${
												totalCost
													? html`<div class="panel-item">
														<span>COST:</span>${totalCost}
													</div>`
													: ""
											}
										</div>
									</div>
									${
										showSessionGallery
											? html`
											<div class="session-gallery" aria-live="polite">
												<div class="session-gallery-header">
													<h3>Resume a Session</h3>
													<span>Select a recent Composer run to continue.</span>
												</div>
												<div class="session-grid">
													${recentSessions.map(
														(session) => html`
															<button
																type="button"
																class="session-card"
																@click=${() => this.selectSession(session.id)}
															>
																<div class="session-card-title">
																	${session.title || `Session ${session.id?.slice(0, 8) || ""}`}
																</div>
																<div class="session-card-meta">
																	<span>${session.messageCount || 0} msgs</span>
																	<span>•</span>
																	<span>Updated ${this.formatSessionDate(session.updatedAt)}</span>
																</div>
															</button>
													`,
													)}
												</div>
											</div>
										`
											: ""
									}
								</div>
						  `
								: html`
												${
													hiddenOldCount > 0
														? html`
																<div class="history-truncation" data-history-truncation>
																	Showing ${visibleCount} of ${totalMessages}${
																		hiddenNewCount > 0
																			? ` (+${hiddenNewCount} newer hidden)`
																			: ""
																	}.
															<button
																class="history-btn"
																@click=${this.loadEarlierMessages}
																?disabled=${this.loadingEarlier}
															>
																${this.loadingEarlier ? "Loading..." : "Load earlier"}
															</button>
																</div>
															`
														: ""
												}
												${topSpacer}
												${renderedMessages}
												${bottomSpacer}
												${
													this.unseenMessages > 0
														? html`
															<button class="jump-latest" @click=${this.jumpToLatest}>
																${this.unseenMessages} new message${this.unseenMessages === 1 ? "" : "s"} — Jump to latest
													</button>
												`
														: ""
												}
									`
						}
					${this.loading ? html`<div class="loading">Processing...</div>` : ""}
				</div>

				<div class="input-container">
					<composer-input
						.apiClient=${this.apiClient}
						.slashCommands=${this.slashCommands}
						@submit=${this.handleSubmit}
						@voice-error=${this.handleVoiceError}
						?disabled=${this.loading || isShared}
						.showHint=${this.footerMode !== "solo"}
					></composer-input>
				</div>

				${
					this.artifactsOpen
						? html`
							<composer-artifacts-panel
								.artifacts=${this.getArtifactsList()}
								.activeFilename=${this.activeArtifact}
								.sessionId=${isShared ? null : this.currentSessionId}
								.apiBaseUrl=${this.apiClient.baseUrl}
								.apiClient=${this.apiClient}
								.attachments=${this.artifactsPanelAttachments}
								@close=${this.closeArtifactsPanel}
								@select-artifact=${(e: CustomEvent<{ filename: string }>) =>
									this.setActiveArtifact(e.detail.filename)}
							></composer-artifacts-panel>
					  `
						: ""
				}
			</div>

			${
				this.settingsOpen
					? html`
				<div class="side-panel settings">
					<composer-settings
						.apiClient=${this.apiClient}
						.currentModel=${this.currentModel}
						@close=${this.toggleSettings}
						@model-select=${this.handleModelSelect}
					></composer-settings>
					</div>
			`
					: ""
			}

			${
				this.adminSettingsOpen && this.hasAdminSettingsAccess()
					? html`
				<div class="side-panel admin">
					<admin-settings
						.apiClient=${this.apiClient}
						@close=${this.toggleAdminSettings}
					></admin-settings>
				</div>
			`
					: ""
			}

			<command-drawer
				?open=${this.commandDrawerOpen}
				.commands=${this.slashCommands}
				.favorites=${this.commandPrefs.favorites}
				.recents=${this.commandPrefs.recents}
				@select-command=${(e: CustomEvent<string>) =>
					this.handleCommandSelect(e.detail)}
				@toggle-favorite=${(e: CustomEvent<string>) =>
					this.handleToggleFavorite(e.detail)}
				@close=${this.closeCommandDrawer}
			></command-drawer>

			${
				this.showModelSelector
					? html`
						<model-selector
							.open=${this.showModelSelector}
							.apiClient=${this.apiClient}
							.apiEndpoint=${this.apiEndpoint}
							.currentModel=${this.currentModel}
							.modelsPrefetch=${this.models}
							@close=${this.closeModelSelector}
							@model-selected=${this.handleModelSelect}
						></model-selector>
				  `
					: ""
			}

			${
				this.showHealth
					? html`
						<div class="health-popover">
							<div class="health-popover-header">
								<span class="health-popover-label">API HEALTH</span>
								<button class="icon-btn" @click=${this.closeHealth}>${this.renderIcon("close")}</button>
							</div>
							<div class="health-popover-row"><span>Base:</span> ${this.apiClient.baseUrl}</div>
							<div class="health-popover-row"><span>Latency:</span> ${latency ? `${Math.round(latency)}ms` : "n/a"}</div>
							<div class="health-popover-row"><span>Last updated:</span> ${lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "n/a"}</div>
							<div class="health-popover-row"><span>Last error:</span> ${this.lastApiError || "none"}</div>
						</div>
				  `
					: ""
			}

			${
				this.toast
					? html`
						<div class="toast ${this.toast.type}">
							${this.toast.message}
						</div>
				  `
					: ""
			}

			${
				this.shareDialogOpen
					? html`
						<composer-share-dialog
							.apiClient=${this.apiClient}
							.sessionId=${this.currentSessionId}
							@close=${this.closeShareDialog}
							@notify=${this.handleDialogNotice}
						></composer-share-dialog>
				  `
					: ""
			}

			${
				this.exportDialogOpen
					? html`
						<composer-export-dialog
							.apiClient=${this.apiClient}
							.sessionId=${this.currentSessionId}
							@close=${this.closeExportDialog}
							@notify=${this.handleDialogNotice}
						></composer-export-dialog>
				  `
					: ""
			}

			${
				this.showShortcuts
					? html`
						<div class="shortcuts-modal">
							<div class="shortcuts-modal-header">
								<span class="shortcuts-modal-title">Keyboard shortcuts</span>
								<button class="icon-btn" @click=${this.closeShortcuts}>${this.renderIcon("close")}</button>
							</div>
						<div class="shortcuts-grid">
							<span class="pill">Enter</span><span>Send message</span>
							<span class="pill">Shift+Enter</span><span>New line</span>
							<span class="pill">?</span><span>Toggle this help</span>
							<span class="pill">↻</span><span>Refresh API status</span>
							<span class="pill">⌘/Ctrl + K</span><span>Browser find (fwd to your editor)</span>
							<span class="pill">⌘/Ctrl + M</span><span>Toggle compact layout</span>
													</div>
					</div>
			  `
					: ""
			}
		`;
	}
}
