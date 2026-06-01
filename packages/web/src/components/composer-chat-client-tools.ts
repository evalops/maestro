import type { ApiClient, Message } from "../services/api-client.js";
import type { Artifact } from "../services/artifacts.js";
import {
	formatMcpPrompt,
	formatMcpPrompts,
	formatMcpResourceRead,
	formatMcpResources,
	formatMcpServers,
	formatMcpTools,
} from "./composer-chat-mcp-formatters.js";
import { ArtifactsRuntimeProvider } from "./sandbox/artifacts-runtime-provider.js";
import { AttachmentsRuntimeProvider } from "./sandbox/attachments-runtime-provider.js";
import { getSandboxConsoleSnapshot } from "./sandbox/console-runtime-provider.js";
import { getSandboxDownloadsSnapshot } from "./sandbox/file-download-runtime-provider.js";
import { FileDownloadRuntimeProvider } from "./sandbox/file-download-runtime-provider.js";
import { JavascriptReplRuntimeProvider } from "./sandbox/javascript-repl-runtime-provider.js";

export interface ComposerChatClientToolResult {
	isError: boolean;
	text: string;
}

export interface ComposerJavascriptReplContext {
	getArtifactsList: () => Artifact[];
	getAllAttachments: () => NonNullable<Message["attachments"]>;
	getSessionScope: () => {
		sessionId: string | null;
		shareToken: string | null;
	};
	hydrateAttachmentsForRequest: (
		attachments: NonNullable<Message["attachments"]>,
		scope: { sessionId: string | null; shareToken: string | null },
	) => Promise<NonNullable<Message["attachments"]>>;
	createOrUpdateArtifact: (filename: string, content: string) => Promise<void>;
	deleteArtifact: (filename: string) => Promise<void>;
	setActiveArtifact: (filename: string) => void;
}

function coerceToolArgsRecord(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	return args as Record<string, unknown>;
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

export async function runComposerJavascriptRepl(
	args: unknown,
	context: ComposerJavascriptReplContext,
): Promise<ComposerChatClientToolResult> {
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
							typeof rec.message === "string" ? rec.message : "Execution error",
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
		() => context.getArtifactsList(),
		{
			createOrUpdate: async (filename, content) => {
				await context.createOrUpdateArtifact(filename, content);
				context.setActiveArtifact(filename);
			},
			delete: async (filename) => {
				await context.deleteArtifact(filename);
			},
		},
	);

	const attachmentsForSandbox = await context.hydrateAttachmentsForRequest(
		context.getAllAttachments(),
		context.getSessionScope(),
	);

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
			// Ignore cleanup failures for the hidden sandbox host.
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
		for (const log of logs) {
			lines.push(`[${log.level}] ${log.text}`);
		}
	}

	if (!errorState.value && lastError) {
		lines.push("", "Last error:");
		lines.push(lastError.message);
		if (lastError.stack) lines.push(lastError.stack);
	}

	if (downloads.length > 0) {
		lines.push("", "Downloads:");
		for (const file of downloads) {
			lines.push(`- ${file.fileName} (${file.mimeType})`);
		}
	}

	return {
		isError: Boolean(errorState.value),
		text: lines.filter(Boolean).join("\n"),
	};
}

export async function runComposerMcpClientTool(
	apiClient: ApiClient,
	toolName: string,
	args: unknown,
): Promise<ComposerChatClientToolResult> {
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

		const result = await apiClient.readMcpResource(server, uri);
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
				? (Object.fromEntries(
						Object.entries(argRecord.args as Record<string, unknown>).filter(
							([, value]) => typeof value === "string",
						),
					) as Record<string, string>)
				: undefined;
		if (!server || !name) {
			return {
				isError: true,
				text: "Error: get_mcp_prompt requires server and name",
			};
		}

		const result = await apiClient.getMcpPrompt(server, name, promptArgs);
		return {
			isError: false,
			text: formatMcpPrompt(result, name),
		};
	}

	const status = await apiClient.getMcpStatus();
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
		return formatMcpPrompts(status, getOptionalStringArg(argRecord, "server"));
	}

	return {
		isError: true,
		text: `Unsupported MCP client tool: ${toolName}`,
	};
}
