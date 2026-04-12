import {
	copyFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentState, AppMessage } from "./agent/types.js";
import {
	type RenderableAssistantMessage,
	type RenderableMessage,
	type RenderableToolCall,
	type RenderableToolResultMessage,
	type RenderableUserMessage,
	buildConversationModel,
	isRenderableAssistantMessage,
	isRenderableToolResultMessage,
	isRenderableUserMessage,
} from "./conversation/render-model.js";
import { sanitizePayload } from "./safety/context-firewall.js";
import type { SessionHeaderEntry, SessionManager } from "./session/manager.js";
import type { SessionEntry } from "./session/types.js";
import { getHomeDir } from "./utils/path-expansion.js";

const normalizeForCompare = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;

// Get version from package.json without import assertions (Node16 compatible)
const packageJson = createRequire(import.meta.url)("../package.json") as {
	version?: string;
};
const VERSION = packageJson.version ?? "unknown";

interface SessionFileParseResult {
	header: SessionHeaderEntry | null;
	messages: AppMessage[];
}

interface PortableExportOptions {
	redactSecrets?: boolean;
}

async function parseSessionFile(
	sessionFile: string,
): Promise<SessionFileParseResult> {
	const messages: AppMessage[] = [];
	let header: SessionHeaderEntry | null = null;
	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const rl = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			try {
				const entry = JSON.parse(trimmed);
				if (entry.type === "session" && !header) {
					header = entry as SessionHeaderEntry;
					continue;
				}
				if (entry.type === "message" && entry.message) {
					messages.push(entry.message as AppMessage);
				}
			} catch {
				// ignore malformed lines
			}
		}
	} finally {
		rl.close();
		stream.close();
	}
	return { header, messages };
}

async function withSessionWriter(
	outputPath: string,
	write: (stream: ReturnType<typeof createWriteStream>) => Promise<void>,
): Promise<void> {
	const stream = createWriteStream(outputPath, { encoding: "utf8" });
	try {
		await write(stream);
		await new Promise<void>((resolvePromise, reject) => {
			stream.end((error?: Error | null) => {
				if (error) {
					reject(error);
					return;
				}
				resolvePromise();
			});
		});
	} catch (error) {
		stream.destroy();
		throw error;
	}
}

function sanitizeEntryForPortableExport(entry: SessionEntry): SessionEntry {
	return sanitizePayload(entry, {
		redactSecrets: true,
		vaultCredentials: false,
		maxStringLength: Number.MAX_SAFE_INTEGER,
		truncateLargeBlobs: false,
	}) as SessionEntry;
}

async function streamPortableEntries(
	sessionFile: string,
	onEntry: (entry: SessionEntry) => Promise<void> | void,
): Promise<void> {
	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const rl = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const entry = JSON.parse(trimmed) as SessionEntry;
			await onEntry(entry);
		}
	} finally {
		rl.close();
		stream.close();
	}
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Shorten path with tilde notation
 */
function shortenPath(path: string): string {
	const home = getHomeDir();
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/");
	const pathCheck = normalizeForCompare(normalizedPath);
	const homeCheck = normalizeForCompare(normalizedHome);
	if (pathCheck === homeCheck) {
		return "~";
	}
	if (pathCheck.startsWith(`${homeCheck}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return path;
}

/**
 * Replace tabs with 3 spaces
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Format tool execution matching TUI ToolExecutionComponent
 */
function formatToolExecution(
	toolCall: RenderableToolCall,
	result?: RenderableToolResultMessage,
): string {
	const toolName = toolCall.name;
	const args = toolCall.arguments;
	const getArg = (key: string): string => {
		const value = args?.[key];
		return typeof value === "string" ? value : "";
	};
	let html = "";
	// Get text output from result
	const getTextOutput = (): string => {
		return result?.textContent ?? "";
	};

	// Format based on tool type (matching TUI logic exactly)
	if (toolName === "bash") {
		const command = getArg("command");
		html = `<div class="tool-command">$ ${escapeHtml(command || "...")}</div>`;

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				const lines = output.split("\n");
				const maxLines = 5;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				if (remaining > 0) {
					// Truncated output - make it expandable
					html +=
						'<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
					html += '<div class="output-preview">';
					for (const line of displayLines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
					html += "</div>";
					html += '<div class="output-full">';
					for (const line of lines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += "</div>";
					html += "</div>";
				} else {
					// Short output - show all
					html += '<div class="tool-output">';
					for (const line of displayLines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += "</div>";
				}
			}
		}
	} else if (toolName === "read") {
		const path = shortenPath(getArg("file_path") || getArg("path"));
		const offset = getArg("offset");
		const limit = getArg("limit");

		// Build path display with line number suffix if offset/limit provided
		let pathDisplay = escapeHtml(path || "...");
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset !== undefined ? Number(offset) : 1;
			const endLine = limit !== undefined ? startLine + Number(limit) - 1 : "";
			pathDisplay += `<span style="color: #b5bd68">:${startLine}${endLine ? `-${endLine}` : ""}</span>`;
		}

		html = `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${pathDisplay}</span></div>`;

		if (result) {
			const output = getTextOutput();
			const lines = output.split("\n");
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			if (remaining > 0) {
				// Truncated output - make it expandable
				html +=
					'<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
				html += '<div class="output-preview">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
				html += "</div>";
				html += '<div class="output-full">';
				for (const line of lines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
				html += "</div>";
			} else {
				// Short output - show all
				html += '<div class="tool-output">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
			}
		}
	} else if (toolName === "write") {
		const path = shortenPath(getArg("file_path") || getArg("path"));
		const fileContent = getArg("content");
		const lines = fileContent ? fileContent.split("\n") : [];
		const totalLines = lines.length;

		html = `<div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${escapeHtml(path || "...")}</span>`;
		if (totalLines > 10) {
			html += ` <span class="line-count">(${totalLines} lines)</span>`;
		}
		html += "</div>";

		if (fileContent) {
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			if (remaining > 0) {
				// Truncated output - make it expandable
				html +=
					'<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
				html += '<div class="output-preview">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
				html += "</div>";
				html += '<div class="output-full">';
				for (const line of lines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
				html += "</div>";
			} else {
				// Short output - show all
				html += '<div class="tool-output">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
			}
		}

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	} else if (toolName === "edit") {
		const path = shortenPath(getArg("file_path") || getArg("path"));
		html = `<div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${escapeHtml(path || "...")}</span></div>`;

		// Show diff if available from result.details.diff
		const diff =
			typeof result?.raw.details === "object" &&
			result.raw.details !== null &&
			"diff" in result.raw.details &&
			typeof (result.raw.details as { diff?: unknown }).diff === "string"
				? (result.raw.details as { diff: string }).diff
				: null;
		if (diff) {
			const diffLines = diff.split("\n");
			html += '<div class="tool-diff">';
			for (const line of diffLines) {
				if (line.startsWith("+")) {
					html += `<div class="diff-line-new">${escapeHtml(line)}</div>`;
				} else if (line.startsWith("-")) {
					html += `<div class="diff-line-old">${escapeHtml(line)}</div>`;
				} else {
					html += `<div class="diff-line-context">${escapeHtml(line)}</div>`;
				}
			}
			html += "</div>";
		}

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	} else {
		// Generic tool
		html = `<div class="tool-header"><span class="tool-name">${escapeHtml(toolName)}</span></div>`;
		html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;

		if (result) {
			const output = getTextOutput();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	}

	if (result?.images?.length) {
		const imageItems = result.images
			.map(
				(image, index) =>
					`<div class="attachment-item">🖼 ${escapeHtml(image.mimeType || "image")} <span>Image ${index + 1}</span></div>`,
			)
			.join("");
		html += `<div class="attachment-list">${imageItems}</div>`;
	}

	return html;
}

function formatRenderableMessageHtml(
	message: RenderableMessage,
	toolResultsMap: Map<string, RenderableToolResultMessage>,
): string {
	if (isRenderableUserMessage(message)) {
		return formatUserMessageHtml(message);
	}
	if (isRenderableAssistantMessage(message)) {
		return formatAssistantMessageHtml(message, toolResultsMap);
	}
	return "";
}

function formatUserMessageHtml(message: RenderableUserMessage): string {
	const textContent = message.text.trim();
	const textHtml = textContent
		? `<div>${escapeHtml(textContent).replace(/\n/g, "<br>")}</div>`
		: "";
	const attachmentsHtml = message.attachments.length
		? `<div class="attachment-list">${message.attachments
				.map(
					(attachment) =>
						`<div class="attachment-item">📎 ${escapeHtml(attachment.fileName)} <span>${escapeHtml(attachment.mimeType)}</span></div>`,
				)
				.join("")}</div>`
		: "";
	if (!textHtml && !attachmentsHtml) {
		return "";
	}

	return `
	<div class="message-wrapper">
		<div class="message-header">
			<div class="user-avatar">U</div>
			User
		</div>
		<div class="user-message">${textHtml}${attachmentsHtml}</div>
	</div>`;
}

function formatAssistantMessageHtml(
	message: RenderableAssistantMessage,
	toolResultsMap: Map<string, RenderableToolResultMessage>,
): string {
	let html = "";

	// Open wrapper
	html += `<div class="message-wrapper">
		<div class="message-header">
			<div class="assistant-avatar">AI</div>
			Maestro
		</div>
		<div class="assistant-message">`;

	for (const text of message.textBlocks) {
		html += `<div class="assistant-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
	}
	for (const thinking of message.thinkingBlocks) {
		html += `<div class="thinking-text">${escapeHtml(thinking).replace(/\n/g, "<br>")}</div>`;
	}
	for (const toolCall of message.toolCalls) {
		const toolResult = toolResultsMap.get(toolCall.id);
		const toolHtml = formatToolExecution(toolCall, toolResult);
		html += `<div class="tool-execution">${toolHtml}</div>`;
	}
	if (message.toolCalls.length === 0) {
		if (message.stopReason === "aborted") {
			html += '<div class="error-text">Aborted</div>';
		} else if (message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			html += `<div class="error-text">Error: ${escapeHtml(errorMsg)}</div>`;
		}
	}

	// Close wrapper
	html += "</div></div>";

	return html;
}

/**
 * Export session to a self-contained HTML file matching TUI visual style
 */
export async function exportSessionToHtml(
	sessionManager: SessionManager,
	state: AgentState,
	outputPath?: string,
): Promise<string> {
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	const timestamp = new Date().toISOString();
	const { header: sessionHeader, messages } =
		await parseSessionFile(sessionFile);
	const renderableMessages = buildConversationModel(messages);
	const toolResultsMap = new Map(
		renderableMessages
			.filter((message): message is RenderableToolResultMessage =>
				isRenderableToolResultMessage(message),
			)
			.map((message) => [message.toolCallId, message] as const),
	);
	const visibleMessages = renderableMessages.filter(
		(message) => !isRenderableToolResultMessage(message),
	);

	const resolvedOutputPath = (() => {
		if (outputPath) {
			return outputPath;
		}
		const sessionBasename = basename(sessionFile, ".jsonl");
		return `${sessionBasename}.html`;
	})();

	const messagesHtml = visibleMessages
		.map((message) => formatRenderableMessageHtml(message, toolResultsMap))
		.join("");

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Export - ${basename(sessionFile)}</title>
    <style>
        :root {
            --bg-color: #0d1117;
            --container-bg: #161b22;
            --border-color: #30363d;
            --text-primary: #c9d1d9;
            --text-secondary: #8b949e;
            --text-dim: #6e7681;
            --accent-color: #58a6ff;
            --success-color: #238636;
            --error-color: #f85149;
            --warning-color: #d29922;
            --user-bg: #1f2428;
            --assistant-bg: #161b22;
            --code-bg: #0d1117;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
            --font-mono: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--font-sans);
            font-size: 14px;
            line-height: 1.6;
            color: var(--text-primary);
            background: var(--bg-color);
            padding: 24px;
        }

        .container {
            max-width: 1000px;
            margin: 0 auto;
        }

        .header {
            margin-bottom: 32px;
            padding: 24px;
            background: var(--container-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.12);
        }

        .header h1 {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 16px;
            color: var(--accent-color);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .header-info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
            font-size: 13px;
        }

        .info-item {
            color: var(--text-secondary);
            display: flex;
            align-items: center;
        }

        .info-label {
            font-weight: 500;
            margin-right: 8px;
            color: var(--text-dim);
            min-width: 70px;
        }

        .info-value {
            color: var(--text-primary);
            font-family: var(--font-mono);
        }

        .messages {
            display: flex;
            flex-direction: column;
            gap: 24px;
        }

        /* Message Containers */
        .message-wrapper {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .message-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-secondary);
            margin-left: 4px;
        }

        .user-avatar, .assistant-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: bold;
        }

        .user-avatar {
            background: var(--accent-color);
            color: #fff;
        }

        .assistant-avatar {
            background: var(--success-color);
            color: #fff;
        }

        /* User Message */
        .user-message {
            background: var(--user-bg);
            padding: 16px 20px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--font-mono);
            font-size: 13px;
        }

        .attachment-list {
            margin-top: 12px;
            border-top: 1px solid var(--border-color);
            padding-top: 8px;
        }

        .attachment-item {
            color: var(--text-secondary);
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* Assistant Message */
        .assistant-message {
            background: transparent;
        }

        .assistant-text {
            padding: 4px 0;
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--font-mono);
            font-size: 13px;
            color: var(--text-primary);
            margin-bottom: 12px;
        }

        /* Thinking Text */
        .thinking-text {
            padding: 12px 16px;
            margin-bottom: 12px;
            background: var(--container-bg);
            border-left: 3px solid var(--text-dim);
            color: var(--text-secondary);
            font-style: italic;
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--font-mono);
            font-size: 12px;
            border-radius: 0 4px 4px 0;
        }

        /* Tools */
        .tool-execution {
            background: var(--container-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            margin-top: 12px;
            overflow: hidden;
            font-family: var(--font-mono);
            font-size: 12px;
        }

        .tool-header {
            padding: 8px 12px;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .tool-name {
            font-weight: 600;
            color: var(--accent-color);
        }

        .tool-path {
            color: var(--text-secondary);
        }

        .line-count {
            color: var(--text-dim);
            font-size: 11px;
        }

        .tool-command {
            color: var(--text-primary);
            font-weight: 500;
        }

        .tool-output {
            padding: 12px;
            color: var(--text-secondary);
            white-space: pre-wrap;
            overflow-x: auto;
            background: var(--code-bg);
        }

        .tool-output.expandable {
            cursor: pointer;
            position: relative;
        }

        .tool-output.expandable:hover {
            background: rgba(255, 255, 255, 0.02);
        }

        .tool-output.expandable .output-full {
            display: none;
        }

        .tool-output.expandable.expanded .output-preview {
            display: none;
        }

        .tool-output.expandable.expanded .output-full {
            display: block;
        }

        .expand-hint {
            color: var(--accent-color);
            font-size: 11px;
            margin-top: 8px;
            opacity: 0.8;
        }

        /* Diff Styling */
        .tool-diff {
            display: flex;
            flex-direction: column;
            width: 100%;
        }

        .diff-line-new {
            background: rgba(46, 160, 67, 0.15);
            color: #e6ffec;
            padding: 0 4px;
        }

        .diff-line-old {
            background: rgba(248, 81, 73, 0.15);
            color: #ffdad8;
            padding: 0 4px;
        }

        .diff-line-context {
            color: var(--text-dim);
            padding: 0 4px;
        }

        /* Error */
        .error-text {
            color: var(--error-color);
            padding: 12px;
            background: rgba(248, 81, 73, 0.1);
            border-radius: 6px;
            margin-top: 8px;
        }

        /* Footer */
        .footer {
            margin-top: 48px;
            padding-top: 24px;
            text-align: center;
            color: var(--text-dim);
            font-size: 12px;
            border-top: 1px solid var(--border-color);
        }

        @media print {
            body {
                background: white;
                color: black;
            }
            .header, .user-message, .tool-execution, .thinking-text {
                border: 1px solid #ddd;
                background: none;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Maestro Session Export</h1>
            <div class="header-info">
                <div class="info-item">
                    <span class="info-label">Session</span>
                    <span class="info-value">${escapeHtml(sessionHeader?.id || "unknown")}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Date</span>
                    <span class="info-value">${sessionHeader?.timestamp ? new Date(sessionHeader.timestamp).toLocaleString() : timestamp}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Model</span>
                    <span class="info-value">${escapeHtml(sessionHeader?.model || state.model.id)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Messages</span>
                    <span class="info-value">${visibleMessages.length}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Directory</span>
                    <span class="info-value">${escapeHtml(shortenPath(sessionHeader?.cwd || process.cwd()))}</span>
                </div>
            </div>
        </div>

        <div class="messages">
            ${messagesHtml}
        </div>

        <div class="footer">
            Generated by Maestro v${VERSION} on ${new Date().toLocaleString()}
        </div>
    </div>
</body>
</html>`;

	writeFileSync(resolvedOutputPath, html, "utf8");
	return resolvedOutputPath;
}

export async function exportSessionToText(
	sessionManager: SessionManager,
	_state: AgentState,
	outputPath?: string,
): Promise<string> {
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	const timestamp = new Date().toISOString();
	const resolvedOutputPath = (() => {
		if (outputPath) {
			return outputPath;
		}
		const sessionBasename = basename(sessionFile, ".jsonl");
		return `${sessionBasename}.txt`;
	})();

	const { messages } = await parseSessionFile(sessionFile);
	const renderableMessages = buildConversationModel(messages);
	const toolResultsMap = new Map(
		renderableMessages
			.filter((message): message is RenderableToolResultMessage =>
				isRenderableToolResultMessage(message),
			)
			.map((message) => [message.toolCallId, message] as const),
	);

	const output: string[] = [];
	output.push(`Session export: ${basename(sessionFile)}`);
	output.push(`Generated: ${timestamp}`);
	output.push("");

	for (const message of renderableMessages) {
		const textBlock = formatMessageAsText(message, toolResultsMap);
		if (textBlock) {
			output.push(textBlock, "");
		}
	}

	writeFileSync(resolvedOutputPath, output.join("\n"), "utf-8");
	return resolvedOutputPath;
}

export async function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	options: PortableExportOptions = {},
): Promise<string> {
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) {
		throw new Error("No persisted session is available to export.");
	}

	const resolvedOutputPath = (() => {
		if (outputPath) {
			return outputPath;
		}
		return basename(sessionFile);
	})();

	if (options.redactSecrets) {
		await withSessionWriter(resolvedOutputPath, async (stream) => {
			await streamPortableEntries(sessionFile, async (entry) => {
				const sanitized = sanitizeEntryForPortableExport(entry);
				stream.write(`${JSON.stringify(sanitized)}\n`);
			});
		});
		return resolvedOutputPath;
	}

	copyFileSync(sessionFile, resolvedOutputPath);
	return resolvedOutputPath;
}

export async function exportSessionToJson(
	sessionManager: SessionManager,
	outputPath?: string,
	options: PortableExportOptions = {},
): Promise<string> {
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) {
		throw new Error("No persisted session is available to export.");
	}

	const resolvedOutputPath = (() => {
		if (outputPath) {
			return outputPath;
		}
		const sessionBasename = basename(sessionFile, ".jsonl");
		return `${sessionBasename}.json`;
	})();

	await withSessionWriter(resolvedOutputPath, async (stream) => {
		stream.write(
			`{"format":"maestro-session-export.v1","exportedAt":${JSON.stringify(new Date().toISOString())},"entries":[`,
		);
		let wroteEntry = false;
		await streamPortableEntries(sessionFile, async (entry) => {
			const exportedEntry = options.redactSecrets
				? sanitizeEntryForPortableExport(entry)
				: entry;
			stream.write(wroteEntry ? "," : "");
			stream.write(JSON.stringify(exportedEntry));
			wroteEntry = true;
		});
		stream.write("]}\n");
	});

	return resolvedOutputPath;
}

function formatMessageAsText(
	message: RenderableMessage,
	toolResultsMap: Map<string, RenderableToolResultMessage>,
): string {
	if (isRenderableUserMessage(message)) {
		const parts: string[] = [];
		if (message.text.trim()) {
			parts.push(message.text.trim());
		}
		if (message.attachments.length) {
			parts.push(
				...message.attachments.map(
					(attachment) =>
						`[attachment] ${attachment.fileName} (${attachment.mimeType})`,
				),
			);
		}
		if (!parts.length) {
			return "";
		}
		return `User:\n${parts.join("\n")}`;
	}
	if (isRenderableAssistantMessage(message)) {
		const parts: string[] = [];
		for (const text of message.textBlocks) {
			if (text.trim()) {
				parts.push(text.trim());
			}
		}
		for (const thinking of message.thinkingBlocks) {
			if (thinking.trim()) {
				parts.push(`[thinking]\n${thinking.trim()}`);
			}
		}
		for (const toolCall of message.toolCalls) {
			const argsString = JSON.stringify(toolCall.arguments, null, 2);
			parts.push(`[tool call] ${toolCall.name}\n${argsString}\n`);
			const result = toolResultsMap.get(toolCall.id);
			if (result?.textContent) {
				parts.push(`[tool result] ${toolCall.name}\n${result.textContent}`);
			}
		}
		if (parts.length === 0) {
			return "";
		}
		return `Assistant:\n${parts.join("\n\n")}`;
	}
	if (isRenderableToolResultMessage(message)) {
		const lines: string[] = [];
		if (message.textContent.trim()) {
			lines.push(message.textContent.trim());
		}
		if (message.images.length) {
			lines.push(
				...message.images.map(
					(image) => `[image] ${image.mimeType || "attachment"}`,
				),
			);
		}
		const text = lines.join("\n");
		return `Tool ${message.toolName} (${message.toolCallId}):\n${text}`;
	}
	return "";
}
