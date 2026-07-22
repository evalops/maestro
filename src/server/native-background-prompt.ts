/**
 * Short-lived native headless one-shot for background text tasks
 * (prompt suggestion, light summaries, etc.).
 *
 * Reuses `runNativeWebChatTurn` with a tight timeout and approval auto.
 * Spawn/start failure is returned to the caller and must fail closed.
 */

import type { AgentEvent, AssistantMessage } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";
import type {
	NativeHeadlessClient,
	NativeHeadlessClientOptions,
} from "./native-headless-client.js";
import {
	type RunNativeWebChatTurnOptions,
	runNativeWebChatTurn,
} from "./web-native-chat.js";

const logger = createLogger("server:native-background-prompt");

/** Default turn budget for background one-shots (prompt suggestion, etc.). */
export const NATIVE_BACKGROUND_PROMPT_TIMEOUT_MS = 60_000;

export type RunNativeBackgroundPromptOptions = {
	prompt: string;
	systemPrompt?: string;
	cwd?: string;
	modelId?: string;
	provider?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Override ready timeout (ms). */
	readyTimeoutMs?: number;
	/** Override turn completion timeout (ms). Default 60s. */
	turnTimeoutMs?: number;
	/** Inject client factory for tests. */
	createClient?: (options: NativeHeadlessClientOptions) => NativeHeadlessClient;
	/**
	 * Inject turn runner for tests. Defaults to `runNativeWebChatTurn`.
	 * When provided, still receives systemPrompt/approvalMode/thinkingLevel.
	 */
	runTurn?: (
		options: RunNativeWebChatTurnOptions,
	) => ReturnType<typeof runNativeWebChatTurn>;
};

export type RunNativeBackgroundPromptResult =
	| { ok: true; text: string }
	| { ok: false; error: Error; phase: "start" | "turn" };

function extractAssistantTextFromMessage(message: AssistantMessage): string {
	const content = message?.content as unknown;
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					Boolean(block) &&
					typeof block === "object" &&
					"type" in block &&
					(block as { type?: string }).type === "text" &&
					"text" in block &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text.trim())
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Collect assistant text from adapted native AgentEvents.
 * Prefers the last `message_end` with non-empty text.
 */
export function collectAssistantTextFromEvents(events: AgentEvent[]): string {
	let last = "";
	for (const event of events) {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = extractAssistantTextFromMessage(
				event.message as AssistantMessage,
			);
			if (text) {
				last = text;
			}
		}
	}
	return last;
}

/**
 * Run a short-lived native headless turn and return the assistant text.
 *
 * - spawn/start failure → `{ ok: false, phase: "start" }`
 * - mid-turn failure → `{ ok: false, phase: "turn" }`
 * - success with empty text still returns `{ ok: true, text: "" }`
 *   (caller decides whether empty is a soft failure)
 */
export async function runNativeBackgroundPrompt(
	options: RunNativeBackgroundPromptOptions,
): Promise<RunNativeBackgroundPromptResult> {
	const events: AgentEvent[] = [];
	const runTurn = options.runTurn ?? runNativeWebChatTurn;
	const turnTimeoutMs =
		options.turnTimeoutMs ?? NATIVE_BACKGROUND_PROMPT_TIMEOUT_MS;

	try {
		const result = await runTurn({
			prompt: options.prompt,
			cwd: options.cwd,
			modelId: options.modelId,
			provider: options.provider,
			env: options.env,
			signal: options.signal,
			readyTimeoutMs: options.readyTimeoutMs,
			turnTimeoutMs,
			thinkingLevel: "off",
			approvalMode: "auto",
			systemPrompt: options.systemPrompt,
			createClient: options.createClient,
			onEvent: (event) => {
				events.push(event);
			},
		});

		if (!result.ok) {
			logger.warn("Native background prompt failed", {
				phase: result.phase,
				error: result.error.message,
			});
			return {
				ok: false,
				error: result.error,
				phase: result.phase,
			};
		}

		const text = collectAssistantTextFromEvents(events);
		return { ok: true, text };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger.warn("Native background prompt threw before start", {
			error: err.message,
		});
		return { ok: false, error: err, phase: "start" };
	}
}
