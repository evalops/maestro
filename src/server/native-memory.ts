/**
 * Native automatic memory coordinators for production server paths.
 *
 * Production defaults use `maestro-tui --headless` for the agent loop. Durable
 * memory extraction/consolidation still run in Node as short-lived native
 * one-shots (`runNativeBackgroundPrompt`) with the same system prompts and
 * persistence logic as the TypeScript background-agent path.
 *
 * Enable (default ON):
 *   MAESTRO_NATIVE_MEMORY=1|true|yes|on  (or unset)
 * Disable:
 *   MAESTRO_NATIVE_MEMORY=0|false|off|no
 * Failures log a warning and never select another agent runtime.
 *
 * @module server/native-memory
 */

import type { Agent, Api, Model } from "../agent/index.js";
import {
	type AutomaticMemoryConsolidationCoordinator,
	createAutomaticMemoryConsolidationCoordinator,
	getMemoryConsolidationSystemPrompt,
} from "../memory/auto-consolidation.js";
import {
	type AutomaticMemoryExtractionCoordinator,
	createAutomaticMemoryExtractionCoordinator,
	getMemoryExtractionSystemPrompt,
} from "../memory/auto-extraction.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { isNativeMemoryEnabled } from "./native-agent-flags.js";
import {
	type RunNativeBackgroundPromptOptions,
	type RunNativeBackgroundPromptResult,
	runNativeBackgroundPrompt,
} from "./native-background-prompt.js";
import {
	createNativeMemoryNoopCoordinators,
	noopAutomaticMemoryConsolidation,
	noopAutomaticMemoryExtraction,
} from "./native-memory-noop.js";

const logger = createLogger("server:native-memory");

export type NativeMemorySessionManager = {
	getSessionFile(): string | null | undefined;
	flush(): Promise<void>;
	saveSessionMemoryExtractionHash(hash: string, sessionPath?: string): void;
};

export type NativeMemoryModelRef = {
	id: string;
	provider?: string;
};

export type NativeMemoryRunPrompt = (
	options: RunNativeBackgroundPromptOptions,
) => Promise<RunNativeBackgroundPromptResult>;

export type NativeMemoryCoordinatorOptions = {
	sessionManager: NativeMemorySessionManager;
	/** Model used for one-shot extraction/consolidation turns. */
	model: NativeMemoryModelRef;
	cwd?: string;
	/** Called after a successful extraction pass (typically schedules consolidation). */
	onProcessed?: () => void;
	/** Inject native one-shot runner for tests. */
	runNativeBackgroundPrompt?: NativeMemoryRunPrompt;
	env?: NodeJS.ProcessEnv;
};

/**
 * Minimal Agent-shaped shim: `prompt()` runs a native headless one-shot and
 * stores the assistant text so existing memory modules can extract JSON.
 * Never constructs a real TypeScript Agent.
 */
function createNativeMemoryPromptAgent(params: {
	systemPrompt: string;
	model: NativeMemoryModelRef;
	cwd?: string;
	runPrompt: NativeMemoryRunPrompt;
	label: string;
}): Agent {
	const state = {
		messages: [] as Array<{
			role: "assistant";
			content: Array<{ type: "text"; text: string }>;
		}>,
	};

	return {
		state,
		prompt: async (userPrompt: string) => {
			const result = await params.runPrompt({
				prompt: userPrompt,
				systemPrompt: params.systemPrompt,
				modelId: params.model.id,
				provider: params.model.provider,
				cwd: params.cwd,
			});
			if (!result.ok) {
				logger.warn(`Native memory ${params.label} one-shot failed`, {
					phase: result.phase,
					error: sanitizeWithStaticMask(result.error.message),
				});
				throw result.error;
			}
			const text = result.text.trim();
			if (!text) {
				throw new Error(
					`Native memory ${params.label} returned no assistant text`,
				);
			}
			state.messages = [
				{
					role: "assistant",
					content: [{ type: "text", text }],
				},
			];
		},
	} as unknown as Agent;
}

function toModelRef(model: NativeMemoryModelRef): Model<Api> {
	return {
		id: model.id,
		provider: model.provider ?? "unknown",
		api: "openai-responses",
	} as Model<Api>;
}

/**
 * Extraction coordinator backed by native one-shots (same schedule/flush API
 * as TypeScript `createAutomaticMemoryExtractionCoordinator`).
 */
export function createNativeMemoryExtractionCoordinator(
	options: NativeMemoryCoordinatorOptions,
): AutomaticMemoryExtractionCoordinator {
	const runPrompt =
		options.runNativeBackgroundPrompt ?? runNativeBackgroundPrompt;

	return createAutomaticMemoryExtractionCoordinator({
		createAgent: async () =>
			createNativeMemoryPromptAgent({
				systemPrompt: getMemoryExtractionSystemPrompt(),
				model: options.model,
				cwd: options.cwd,
				runPrompt,
				label: "extraction",
			}),
		getModel: () => toModelRef(options.model),
		onProcessed: options.onProcessed,
		sessionManager: options.sessionManager,
	});
}

/**
 * Consolidation coordinator backed by native one-shots.
 */
export function createNativeMemoryConsolidationCoordinator(
	options: Pick<
		NativeMemoryCoordinatorOptions,
		"model" | "cwd" | "runNativeBackgroundPrompt"
	>,
): AutomaticMemoryConsolidationCoordinator {
	const runPrompt =
		options.runNativeBackgroundPrompt ?? runNativeBackgroundPrompt;

	return createAutomaticMemoryConsolidationCoordinator({
		createAgent: async () =>
			createNativeMemoryPromptAgent({
				systemPrompt: getMemoryConsolidationSystemPrompt(),
				model: options.model,
				cwd: options.cwd,
				runPrompt,
				label: "consolidation",
			}),
		getModel: () => toModelRef(options.model),
	});
}

/**
 * Pair of native memory coordinators (extraction triggers consolidation).
 * Returns no-ops when `MAESTRO_NATIVE_MEMORY` is off.
 */
export function createNativeMemoryCoordinators(options: {
	sessionManager: NativeMemorySessionManager;
	model: NativeMemoryModelRef;
	cwd?: string;
	runNativeBackgroundPrompt?: NativeMemoryRunPrompt;
	env?: NodeJS.ProcessEnv;
}): {
	extraction: AutomaticMemoryExtractionCoordinator;
	consolidation: AutomaticMemoryConsolidationCoordinator;
} {
	if (!isNativeMemoryEnabled(options.env)) {
		return createNativeMemoryNoopCoordinators();
	}

	const consolidation = createNativeMemoryConsolidationCoordinator({
		model: options.model,
		cwd: options.cwd,
		runNativeBackgroundPrompt: options.runNativeBackgroundPrompt,
	});
	const extraction = createNativeMemoryExtractionCoordinator({
		sessionManager: options.sessionManager,
		model: options.model,
		cwd: options.cwd,
		runNativeBackgroundPrompt: options.runNativeBackgroundPrompt,
		onProcessed: () => consolidation.schedule(),
	});
	return { extraction, consolidation };
}

/** Re-export no-ops for callers that disable native memory scheduling. */
export {
	createNativeMemoryNoopCoordinators,
	noopAutomaticMemoryConsolidation,
	noopAutomaticMemoryExtraction,
};
