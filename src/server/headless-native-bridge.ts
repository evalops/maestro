/**
 * Helpers for the HeadlessRuntimeService native maestro-tui --headless backend.
 *
 * Keeps spawn/ready wiring and protocol message publishing out of the large
 * headless-runtime-service module. Utility commands, file watches, and
 * connection/hello remain Node-side; only the agent loop is native.
 *
 * The native process owns inference; Node still persists translated messages
 * and schedules its native one-shot memory coordinators.
 */

import type {
	HeadlessApprovalMode,
	HeadlessFromAgentMessage,
	HeadlessReadyMessage,
	HeadlessThinkingLevel,
} from "../cli/headless-protocol.js";
import type { ComposerConfig } from "../config/index.js";
import { getPackageName, getPackageVersion } from "../package-metadata.js";
import {
	NativeHeadlessClient,
	type NativeHeadlessClientOptions,
} from "./native-headless-client.js";
import { resolveNativeSystemPrompt } from "./native-system-prompt.js";
import type { NativeSystemPromptResolution } from "./native-system-prompt.js";

export type StartNativeHeadlessBackendOptions = {
	cwd?: string;
	/** Profile used when resolving the Maestro system prompt (createAgent parity). */
	profileName?: string;
	/** CLI/profile overrides used when resolving the Maestro system prompt. */
	cliOverrides?: Partial<ComposerConfig>;
	modelId?: string;
	provider?: string;
	env?: NodeJS.ProcessEnv;
	readyTimeoutMs?: number;
	/** Inject client factory for tests. */
	createClient?: (options: NativeHeadlessClientOptions) => NativeHeadlessClient;
	/** Sent after ready (before callers attach listeners). */
	thinkingLevel?: HeadlessThinkingLevel;
	approvalMode?: HeadlessApprovalMode;
	/**
	 * System prompt for headless `init.system_prompt`.
	 * When omitted, resolves the Maestro system prompt (cwd/profile/cliOverrides).
	 * Pass an explicit string (including "") to skip resolution.
	 */
	systemPrompt?: string;
	/** Hello client name sent once after start. Default maestro-headless-runtime. */
	clientName?: string;
};

export type StartNativeHeadlessBackendResult = NativeSystemPromptResolution & {
	client: NativeHeadlessClient;
	ready: HeadlessReadyMessage;
};

/**
 * Spawn maestro-tui --headless, wait for ready, send hello + optional init.
 */
export async function startNativeHeadlessBackend(
	options: StartNativeHeadlessBackendOptions,
): Promise<StartNativeHeadlessBackendResult> {
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
		cwd: options.cwd,
		env,
		readyTimeoutMs: options.readyTimeoutMs,
	};

	const client = options.createClient
		? options.createClient(clientOptions)
		: new NativeHeadlessClient(clientOptions);

	try {
		const ready = await client.start();

		client.hello({
			clientName: options.clientName ?? "maestro-headless-runtime",
			role: "controller",
		});

		const promptResolution = await resolveNativeSystemPrompt({
			systemPrompt: options.systemPrompt,
			cwd: options.cwd,
			profileName: options.profileName,
			cliOverrides: options.cliOverrides,
			env,
		});

		// Always init: system prompt is required for createAgent parity; thinking/
		// approval are optional overlays.
		client.init({
			...(options.thinkingLevel !== undefined
				? { thinking_level: options.thinkingLevel }
				: {}),
			...(options.approvalMode !== undefined
				? { approval_mode: options.approvalMode }
				: {}),
			system_prompt: promptResolution.systemPrompt,
		});

		return { client, ready, ...promptResolution };
	} catch (error) {
		client.stop();
		throw error;
	}
}

export type AttachNativeHeadlessPublisherOptions = {
	client: NativeHeadlessClient;
	/** Publish protocol messages into the Node broker (already protocol-shaped). */
	publish: (message: HeadlessFromAgentMessage) => void;
	/** Called when a full agentic turn ends (done/blocked) or process exits. */
	onIdle?: () => void;
	/** Called when native process exits. */
	onExit?: (code: number | null) => void;
	/** Called for fatal / unexpected client errors (non-parse). */
	onError?: (error: Error) => void;
};

/**
 * Bridge native NDJSON messages into the headless runtime publisher.
 * Does NOT run the TS translator.handleAgentEvent path — messages are already
 * HeadlessFromAgentMessage.
 */
export function attachNativeHeadlessPublisher(
	options: AttachNativeHeadlessPublisherOptions,
): () => void {
	const { client, publish, onIdle, onExit, onError } = options;

	const onMessage = (message: HeadlessFromAgentMessage) => {
		publish(message);
		if (isTerminalTurnMessage(message)) {
			onIdle?.();
		}
	};

	const onClientError = (error: unknown) => {
		const err = error instanceof Error ? error : new Error(String(error));
		// Non-fatal parse noise should not tear down the runtime.
		if (err.message.startsWith("Failed to parse")) {
			return;
		}
		onError?.(err);
	};

	const onClientExit = (code: number | null) => {
		onIdle?.();
		onExit?.(code);
	};

	client.on("message", onMessage);
	client.on("error", onClientError);
	client.on("exit", onClientExit);

	return () => {
		client.off("message", onMessage);
		client.off("error", onClientError);
		client.off("exit", onClientExit);
	};
}

/**
 * Native agent emits intermediate `response_end` after each LLM round (before
 * tools), then a sentinel `response_id: "done"` when the full agentic loop
 * finishes. Hook-blocked prompts use `response_id: "blocked"`.
 */
export function isTerminalTurnMessage(
	message: HeadlessFromAgentMessage,
): boolean {
	if (message.type === "response_end") {
		return message.response_id === "done" || message.response_id === "blocked";
	}
	if (message.type === "error" && message.fatal) {
		return true;
	}
	return false;
}
