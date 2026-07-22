/**
 * Native headless path for web chat (SSE + WebSocket).
 *
 * Handlers require `maestro-tui --headless`. Native start or turn failures
 * return an error; there is no alternate agent runtime.
 *
 * Prior conversation is sent through structured `history` so user content is
 * never promoted into the trusted system prompt.
 *
 * Known gaps vs full TS path:
 * - Client tools / interactive approval UI are not fully bridged. Explicit
 *   auto mode remains automatic; prompt/fail modes fail closed.
 * - Automatic memory uses separate native one-shots (`native-memory.ts`; default
 *   ON via `MAESTRO_NATIVE_MEMORY`) — not in-process TS background agents
 * - Web-session **agent** bind is skipped (`bindAgentSession` needs a TS Agent and
 *   would fail the turn). Handlers may call `ensureSession` / `getOrCreate` so
 *   `/api/composer` has session affinity; activate/deactivate then store UI state
 *   only — they do **not** change the native headless system prompt or tools.
 * - Session persistence is best-effort (user message + message_end)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ComposerMessage } from "@evalops/contracts";
import type { AgentEvent, Attachment } from "../agent/types.js";
import type {
	HeadlessApprovalMode,
	HeadlessFromAgentMessage,
	HeadlessHistoryMessage,
	HeadlessHistoryRole,
	HeadlessThinkingLevel,
} from "../cli/headless-protocol.js";
import type { ComposerConfig } from "../config/index.js";
import { getPackageName, getPackageVersion } from "../package-metadata.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import { createLogger } from "../utils/logger.js";
import {
	NativeHeadlessClient,
	type NativeHeadlessClientOptions,
} from "./native-headless-client.js";
import { createNativeHeadlessEventAdapter } from "./native-headless-event-adapter.js";
import {
	type NativeSystemPromptResolution,
	resolveNativeSystemPrompt,
} from "./native-system-prompt.js";

const logger = createLogger("web:native-chat");

/** Soft budget shared by structured history and the compatibility fallback. */
export const NATIVE_HISTORY_CHAR_BUDGET = 32_000;

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/webp": ".webp",
};

const NATIVE_IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_EXTENSION_BY_MIME));

const HEADLESS_THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"ultra",
]);

export type NativeChatHistoryEntry = {
	role: "user" | "assistant" | string;
	text: string;
};

export type RunNativeWebChatTurnOptions = {
	prompt: string;
	/** Uploaded content materialized to private temporary files for native input. */
	attachments?: Attachment[];
	cwd?: string;
	/** Profile used when resolving the Maestro system prompt (createAgent parity). */
	profileName?: string;
	/** CLI/profile overrides used when resolving the Maestro system prompt. */
	cliOverrides?: Partial<ComposerConfig>;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	approvalMode?: string;
	/**
	 * Prior conversation turns (excluding the current user prompt).
	 * Sent through structured init.history and a compatibility transcript for
	 * older native binaries that ignore the structured field.
	 */
	history?: NativeChatHistoryEntry[];
	/** Trusted server-owned system guidance appended to the base prompt. */
	systemPromptAppend?: string;
	/**
	 * System prompt for headless `init.system_prompt`.
	 * When omitted, resolves the Maestro system prompt (cwd/profile/cliOverrides).
	 * Pass an explicit string (including "") to skip resolution.
	 */
	systemPrompt?: string;
	env?: NodeJS.ProcessEnv;
	/** Called before protocol writes for policy checks and session initialization. */
	onBeforePrompt?: (
		details: NativeSystemPromptResolution,
	) => void | Promise<void>;
	/** Called after the prompt is accepted by the native child. */
	onStarted?: (details: NativeSystemPromptResolution) => void | Promise<void>;
	onEvent: (event: AgentEvent) => void;
	signal?: AbortSignal;
	/** Inject client factory for tests. */
	createClient?: (options: NativeHeadlessClientOptions) => NativeHeadlessClient;
	/** Override ready timeout (ms). */
	readyTimeoutMs?: number;
	/** Override turn completion timeout (ms). Default 15 minutes. */
	turnTimeoutMs?: number;
};

export type RunNativeWebChatTurnResult =
	| { ok: true }
	| { ok: false; error: Error; phase: "start" | "turn" };

function mapThinkingLevel(
	level: string | undefined,
): HeadlessThinkingLevel | undefined {
	if (!level) return undefined;
	const normalized = level === "max" ? "ultra" : level;
	if (HEADLESS_THINKING_LEVELS.has(normalized)) {
		return normalized as HeadlessThinkingLevel;
	}
	return undefined;
}

/**
 * Map web/server approval modes onto native headless modes.
 *
 * Interactive approval is not bridged on one-shot server surfaces, so prompt
 * must fail closed. Explicit auto remains auto; every other mode denies tools
 * that require approval instead of silently escalating privileges.
 */
export function mapApprovalModeForNative(
	mode: string | undefined,
): HeadlessApprovalMode {
	return mode === "auto" ? "auto" : "fail";
}

/** Long-lived controllers can answer native approval requests. */
export function mapControllerApprovalModeForNative(
	mode: string | undefined,
): HeadlessApprovalMode {
	return mode === "auto" || mode === "prompt" ? mode : "fail";
}

export function getComposerTextContent(
	content: ComposerMessage["content"],
): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function getComposerAttachmentContext(message: ComposerMessage): string {
	return (message.attachments ?? [])
		.map((attachment) => {
			const name = attachment.fileName.trim() || "attachment";
			const extractedText = attachment.extractedText?.trim();
			return extractedText
				? `[Attachment: ${name}]\n${extractedText}`
				: `[Attachment: ${name} (${attachment.mimeType})]`;
		})
		.join("\n\n");
}

/** Prior turns for native headless, including durable attachment context. */
export function composerHistoryForNative(
	messages: ComposerMessage[],
): NativeChatHistoryEntry[] {
	const history: NativeChatHistoryEntry[] = [];
	for (const message of messages.slice(0, -1)) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = [
			getComposerTextContent(message.content).trim(),
			getComposerAttachmentContext(message),
		]
			.filter(Boolean)
			.join("\n\n");
		if (text) {
			history.push({ role: message.role, text });
		}
	}
	return history;
}

async function materializeNativeAttachments(
	attachments: Attachment[] | undefined,
): Promise<{ paths: string[] | undefined; cleanup: () => Promise<void> }> {
	if (!attachments?.length) {
		return { paths: undefined, cleanup: async () => {} };
	}
	const directory = await mkdtemp(join(tmpdir(), "maestro-web-attachments-"));
	try {
		const paths: string[] = [];
		for (const [index, attachment] of attachments.entries()) {
			let safeName = basename(attachment.fileName).replace(
				/[^a-zA-Z0-9._-]/g,
				"_",
			);
			const imageExtension = IMAGE_EXTENSION_BY_MIME[attachment.mimeType];
			if (
				attachment.type === "image" &&
				imageExtension &&
				!NATIVE_IMAGE_EXTENSIONS.has(extname(safeName).toLowerCase())
			) {
				safeName = `${safeName || "attachment"}${imageExtension}`;
			}
			const extractedText = attachment.extractedText?.trim() ?? "";
			const useExtractedDocument =
				attachment.type === "document" && Boolean(extractedText);
			const path = join(
				directory,
				`${index}-${safeName || "attachment"}${useExtractedDocument ? ".txt" : ""}`,
			);
			const content = useExtractedDocument
				? `[Document: ${attachment.fileName}]\n${extractedText}`
				: Buffer.from(attachment.content, "base64").toString("latin1");
			writeTextFileAtomic(path, content, {
				encoding: useExtractedDocument ? "utf-8" : "latin1",
				createDirs: false,
				mode: 0o600,
			});
			paths.push(path);
		}
		return {
			paths,
			cleanup: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function roleLabel(role: string): string {
	const normalized = role.trim().toLowerCase();
	if (normalized === "user") return "User";
	if (normalized === "assistant" || normalized === "model") return "Assistant";
	if (normalized === "system") return "System";
	if (!normalized) return "Unknown";
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/** Map free-form roles onto headless protocol HistoryRole values. */
export function toHeadlessHistoryRole(role: string): HeadlessHistoryRole {
	const normalized = role.trim().toLowerCase();
	if (normalized === "assistant" || normalized === "model") return "assistant";
	if (normalized === "system") return "system";
	return "user";
}

/**
 * Select recent history turns under a soft char budget (most-recent first).
 * Shared by structured protocol history and the append_system_prompt fallback.
 */
export function selectConversationHistoryForNative(
	history: Array<{ role: string; text: string }>,
	charBudget: number = NATIVE_HISTORY_CHAR_BUDGET,
): Array<{ role: string; text: string }> {
	if (!history.length || charBudget <= 0) return [];

	const selected: Array<{ role: string; text: string }> = [];
	let used = 0;

	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry) continue;
		const text = entry?.text?.trim() ?? "";
		if (!text) continue;

		const line = `${roleLabel(entry.role)}: ${text}`;
		const overhead = selected.length > 0 ? 1 : 0; // newline between lines

		if (used + overhead + line.length > charBudget) {
			if (selected.length === 0) {
				// Single oversized turn: keep a truncated tail of the budget.
				const truncated =
					text.length > charBudget ? text.slice(0, charBudget) : text;
				if (truncated.length > 0) {
					selected.unshift({ role: entry.role, text: truncated });
				}
			}
			break;
		}

		selected.unshift({ role: entry.role, text });
		used += overhead + line.length;
	}

	return selected;
}

/**
 * Map selected turns to headless protocol history entries (init.history).
 */
export function toHeadlessProtocolHistory(
	history: Array<{ role: string; text: string }>,
	charBudget: number = NATIVE_HISTORY_CHAR_BUDGET,
): HeadlessHistoryMessage[] | undefined {
	const selected = selectConversationHistoryForNative(history, charBudget);
	if (selected.length === 0) return undefined;
	return selected.map((entry) => ({
		role: toHeadlessHistoryRole(entry.role),
		content: entry.text,
	}));
}

/** Format prior turns for native binaries that do not support init.history. */
export function formatConversationHistoryForNative(
	history: Array<{ role: string; text: string }>,
	charBudget: number = NATIVE_HISTORY_CHAR_BUDGET,
): string | undefined {
	const selected = selectConversationHistoryForNative(history, charBudget);
	if (selected.length === 0) return undefined;
	const lines = selected.map(
		(entry) => `${roleLabel(entry.role)}: ${entry.text}`,
	);
	return `## Prior conversation\n${lines.join("\n")}`;
}

/**
 * Native agent emits intermediate `response_end` after each LLM round (before
 * tools), then a sentinel `response_id: "done"` when the full agentic loop
 * finishes. Hook-blocked prompts use `response_id: "blocked"`.
 *
 * Completing on every `response_end` kills the child mid-tool-loop.
 */
function isTerminalTurnMessage(message: HeadlessFromAgentMessage): boolean {
	if (message.type === "response_end") {
		return message.response_id === "done" || message.response_id === "blocked";
	}
	if (message.type === "error" && message.fatal) {
		return true;
	}
	return false;
}

/**
 * Run a single web chat turn via maestro-tui --headless.
 *
 * - start failure → `{ ok: false, phase: "start" }`
 * - mid-turn failure after start → streams error events when possible,
 *   returns `{ ok: false, phase: "turn" }`
 * - success (sentinel response_end `done`/`blocked`) → { ok: true }
 */
export async function runNativeWebChatTurn(
	options: RunNativeWebChatTurnOptions,
): Promise<RunNativeWebChatTurnResult> {
	const baseEnv = options.env ?? process.env;
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		MAESTRO_PACKAGE_NAME: getPackageName(baseEnv),
		MAESTRO_VERSION: getPackageVersion(baseEnv),
	};
	if (options.modelId) {
		env.MAESTRO_MODEL = options.modelId;
	}
	if (options.provider) {
		env.MAESTRO_PROVIDER = options.provider;
	}

	const clientOptions: NativeHeadlessClientOptions = {
		cwd: options.cwd ?? process.cwd(),
		env,
		readyTimeoutMs: options.readyTimeoutMs,
	};

	const client = options.createClient
		? options.createClient(clientOptions)
		: new NativeHeadlessClient(clientOptions);

	let started = false;
	let attachmentCleanup = async () => {};

	const cleanup = () => {
		try {
			client.stop();
		} catch {
			// ignore stop failures
		}
	};

	try {
		if (options.signal?.aborted) {
			return {
				ok: false,
				error: new Error("Native web chat aborted before start"),
				phase: "start",
			};
		}

		await client.start();
		started = true;

		const adapter = createNativeHeadlessEventAdapter({
			modelId: options.modelId,
			provider: options.provider,
		});

		const turnTimeoutMs = options.turnTimeoutMs ?? 15 * 60 * 1000;
		// Prefer structured history while retaining the older native fallback.
		const protocolHistory = toHeadlessProtocolHistory(options.history ?? []);
		const historyFallback = formatConversationHistoryForNative(
			options.history ?? [],
		);
		const appendSystemPrompt =
			[historyFallback, options.systemPromptAppend?.trim()]
				.filter((part): part is string => Boolean(part))
				.join("\n\n") || undefined;
		const cwd = options.cwd ?? process.cwd();
		const promptResolution = await resolveNativeSystemPrompt({
			systemPrompt: options.systemPrompt,
			cwd,
			profileName: options.profileName,
			cliOverrides: options.cliOverrides,
			env,
		});
		const materializedAttachments = await materializeNativeAttachments(
			options.attachments,
		);
		attachmentCleanup = materializedAttachments.cleanup;
		if (options.onBeforePrompt) {
			await options.onBeforePrompt(promptResolution);
		}

		let teardownTurn = () => {};
		let releaseBufferedMessages = () => {};
		const turnPromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			let messagesReleased = false;
			const bufferedMessages: HeadlessFromAgentMessage[] = [];

			const settleOk = () => {
				if (settled) return;
				settled = true;
				teardown();
				resolve();
			};

			const settleErr = (error: Error) => {
				if (settled) return;
				settled = true;
				teardown();
				reject(error);
			};

			const processMessage = (message: HeadlessFromAgentMessage) => {
				try {
					const events = adapter.handle(message);
					for (const event of events) {
						options.onEvent(event);
					}
				} catch (error) {
					settleErr(
						error instanceof Error
							? error
							: new Error(`Adapter failed: ${String(error)}`),
					);
					return;
				}

				if (isTerminalTurnMessage(message)) {
					// Give agent_end (emitted with response_end) a chance to flush via onEvent.
					settleOk();
				}
			};
			const onMessage = (message: HeadlessFromAgentMessage) => {
				if (!messagesReleased) {
					bufferedMessages.push(message);
					return;
				}
				processMessage(message);
			};
			releaseBufferedMessages = () => {
				messagesReleased = true;
				for (const message of bufferedMessages.splice(0)) {
					processMessage(message);
				}
			};

			const onError = (error: unknown) => {
				const err = error instanceof Error ? error : new Error(String(error));
				// Non-fatal parse errors should not kill the turn.
				if (err.message.startsWith("Failed to parse")) {
					logger.warn("Ignoring non-fatal native headless parse error", {
						error: err.message,
					});
					return;
				}
				// Fatal protocol errors may already have emitted agent events.
				try {
					options.onEvent({ type: "error", message: err.message });
				} catch {
					// ignore
				}
				settleErr(err);
			};

			const onExit = (code: number | null) => {
				if (settled) return;
				if (code === 0 || code === null) {
					settleOk();
					return;
				}
				settleErr(
					new Error(
						`Native headless process exited during turn (code=${code})`,
					),
				);
			};

			const onAbort = () => {
				try {
					client.interrupt();
				} catch {
					// ignore
				}
				settleErr(new Error("Native web chat turn aborted"));
			};

			const timer = setTimeout(() => {
				settleErr(
					new Error(`Native web chat turn timed out after ${turnTimeoutMs}ms`),
				);
			}, turnTimeoutMs);

			const teardown = () => {
				clearTimeout(timer);
				client.off("message", onMessage);
				client.off("error", onError);
				client.off("exit", onExit);
				options.signal?.removeEventListener("abort", onAbort);
			};
			teardownTurn = teardown;

			client.on("message", onMessage);
			client.on("error", onError);
			client.on("exit", onExit);
			options.signal?.addEventListener("abort", onAbort, { once: true });

			if (options.signal?.aborted) {
				onAbort();
				return;
			}
		});
		// Attach a rejection handler before awaiting onStarted so an abort during
		// async session persistence cannot become an unhandled rejection.
		void turnPromise.catch(() => {});

		try {
			if (options.signal?.aborted) {
				await turnPromise;
			}
			client.hello({ clientName: "maestro-web", role: "controller" });
			// Prompt-mode one-shots fail closed because no interactive bridge exists.
			client.init({
				approval_mode: mapApprovalModeForNative(options.approvalMode),
				...(mapThinkingLevel(options.thinkingLevel)
					? { thinking_level: mapThinkingLevel(options.thinkingLevel) }
					: {}),
				...(protocolHistory ? { history: protocolHistory } : {}),
				...(appendSystemPrompt
					? { append_system_prompt: appendSystemPrompt }
					: {}),
				system_prompt: promptResolution.systemPrompt,
			});
			client.prompt(options.prompt, materializedAttachments.paths);
			if (options.onStarted) {
				await options.onStarted(promptResolution);
			}
			releaseBufferedMessages();
			await turnPromise;
		} catch (error) {
			teardownTurn();
			throw error;
		}

		return { ok: true };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		if (!started) {
			return { ok: false, error: err, phase: "start" };
		}
		return { ok: false, error: err, phase: "turn" };
	} finally {
		cleanup();
		await attachmentCleanup();
	}
}
