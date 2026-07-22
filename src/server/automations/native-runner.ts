/**
 * Native headless path for scheduled automations.
 *
 * Automations spawn `maestro-tui --headless` via runNativeWebChatTurn.
 * Native failures fail the automation run.
 *
 * Session persistence and memory scheduling remain Node-side; inference is
 * always delegated to the native process.
 */

import type { AgentEvent } from "../../agent/types.js";
import type { ComposerConfig } from "../../config/index.js";
import {
	type NativeChatHistoryEntry,
	type RunNativeWebChatTurnOptions,
	type RunNativeWebChatTurnResult,
	runNativeWebChatTurn,
} from "../web-native-chat.js";

export type RunAutomationNativeTurnOptions = {
	prompt: string;
	cwd?: string;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	approvalMode?: string;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
	/**
	 * Prior conversation turns when resuming a session (same as web chat).
	 * Sent through init.history by runNativeWebChatTurn.
	 */
	history?: NativeChatHistoryEntry[];
	signal?: AbortSignal;
	onStarted?: RunNativeWebChatTurnOptions["onStarted"];
	onEvent: (event: AgentEvent) => void;
	/** Inject for tests. */
	runTurn?: typeof runNativeWebChatTurn;
};

/**
 * Run one automation turn via maestro-tui --headless.
 * Thin wrapper around runNativeWebChatTurn with automation defaults
 * (approvalMode: "auto" unless overridden).
 */
export async function runAutomationNativeTurn(
	options: RunAutomationNativeTurnOptions,
): Promise<RunNativeWebChatTurnResult> {
	const runTurn = options.runTurn ?? runNativeWebChatTurn;
	return runTurn({
		prompt: options.prompt,
		cwd: options.cwd,
		modelId: options.modelId,
		provider: options.provider,
		thinkingLevel: options.thinkingLevel,
		approvalMode: options.approvalMode ?? "auto",
		profileName: options.profileName,
		cliOverrides: options.cliOverrides,
		history: options.history,
		onStarted: options.onStarted,
		onEvent: options.onEvent,
		signal: options.signal,
	});
}
