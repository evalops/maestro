/**
 * Session Export Formatters - Markdown and text export for sessions
 *
 * @module web/handlers/session-export-formatters
 */

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
	arguments?: unknown;
	content?: string | ContentBlock[];
	tool_use_id?: string;
	is_error?: boolean;
}

/**
 * Export session to markdown format with full support for complex messages
 */
export function exportToMarkdown(
	session: { id: string; title?: string; createdAt?: string },
	messages: Array<{ role: string; content?: unknown }>,
): string {
	const lines: string[] = [
		`# ${session.title || `Session ${session.id.slice(0, 8)}`}`,
		"",
		`*Created: ${session.createdAt || "Unknown"}*`,
		"",
		"---",
		"",
	];

	for (const msg of messages) {
		const role =
			msg.role === "user"
				? "## User"
				: msg.role === "toolResult"
					? "## Tool Result"
					: "## Assistant";
		lines.push(role);
		lines.push("");

		const contentLines = formatMessageContent(msg.content, "markdown");
		lines.push(...contentLines);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Export session to plain text format with full support for complex messages
 */
export function exportToText(
	session: { id: string; title?: string; createdAt?: string },
	messages: Array<{ role: string; content?: unknown }>,
): string {
	const lines: string[] = [
		`Session: ${session.title || session.id}`,
		`Created: ${session.createdAt || "Unknown"}`,
		"",
		"=".repeat(60),
		"",
	];

	for (const msg of messages) {
		const role =
			msg.role === "user"
				? "USER:"
				: msg.role === "toolResult"
					? "TOOL RESULT:"
					: "ASSISTANT:";
		lines.push(role);
		lines.push("");

		const contentLines = formatMessageContent(msg.content, "text");
		lines.push(...contentLines);
		lines.push("");
		lines.push("-".repeat(40));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Format message content handling all block types
 */
function formatMessageContent(
	content: unknown,
	format: "markdown" | "text",
): string[] {
	const lines: string[] = [];

	if (typeof content === "string") {
		lines.push(content);
		return lines;
	}

	if (!Array.isArray(content)) {
		return lines;
	}

	for (const block of content as ContentBlock[]) {
		if (!block || typeof block !== "object") continue;

		switch (block.type) {
			case "text":
				if (block.text) {
					lines.push(block.text);
				}
				break;

			case "tool_use":
				if (format === "markdown") {
					lines.push(`### Tool: \`${block.name || "unknown"}\``);
					lines.push("");
					if (block.input) {
						lines.push("```json");
						lines.push(JSON.stringify(block.input, null, 2));
						lines.push("```");
					}
				} else {
					lines.push(`[TOOL CALL: ${block.name || "unknown"}]`);
					if (block.input) {
						lines.push(`Input: ${JSON.stringify(block.input, null, 2)}`);
					}
				}
				lines.push("");
				break;

			case "toolCall":
				if (format === "markdown") {
					lines.push(`### Tool: \`${block.name || "unknown"}\``);
					if (block.arguments) {
						lines.push("");
						lines.push("```json");
						lines.push(JSON.stringify(block.arguments, null, 2));
						lines.push("```");
					}
				} else {
					lines.push(`[TOOL CALL: ${block.name || "unknown"}]`);
					if (block.arguments) {
						lines.push(`Args: ${JSON.stringify(block.arguments, null, 2)}`);
					}
				}
				lines.push("");
				break;

			case "tool_result":
				if (format === "markdown") {
					lines.push("#### Tool Result");
					if (block.is_error) {
						lines.push("**Error:**");
					}
					lines.push("");
					const resultContent = formatToolResultContent(block.content, format);
					lines.push(...resultContent);
				} else {
					lines.push("[TOOL RESULT]");
					if (block.is_error) {
						lines.push("(Error)");
					}
					const resultContent = formatToolResultContent(block.content, format);
					lines.push(...resultContent);
				}
				lines.push("");
				break;

			case "image":
				if (format === "markdown") {
					lines.push("*[Image content]*");
				} else {
					lines.push("[IMAGE]");
				}
				break;

			case "thinking":
				if (format === "markdown") {
					lines.push("<details>");
					lines.push("<summary>Thinking...</summary>");
					lines.push("");
					if (block.text) {
						lines.push(block.text);
					}
					lines.push("</details>");
				} else {
					lines.push("[THINKING]");
					if (block.text) {
						lines.push(block.text);
					}
					lines.push("[/THINKING]");
				}
				lines.push("");
				break;

			default:
				// Handle unknown block types gracefully
				if (block.text) {
					lines.push(block.text);
				}
		}
	}

	return lines;
}

/**
 * Format tool result content which can be string or nested blocks
 */
function formatToolResultContent(
	content: string | ContentBlock[] | undefined,
	format: "markdown" | "text",
): string[] {
	if (!content) return [];

	if (typeof content === "string") {
		if (format === "markdown") {
			return ["```", content, "```"];
		}
		return [content];
	}

	if (Array.isArray(content)) {
		const lines: string[] = [];
		for (const block of content) {
			if (block.type === "text" && block.text) {
				if (format === "markdown") {
					lines.push("```");
					lines.push(block.text);
					lines.push("```");
				} else {
					lines.push(block.text);
				}
			}
		}
		return lines;
	}

	return [];
}
