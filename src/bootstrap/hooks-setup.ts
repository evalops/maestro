/**
 * TypeScript Hooks Initialization - Discovery, loading, and global handler wiring.
 *
 * Extracts hook setup from main.ts Phase 11.5:
 * hook discovery/loading, send handler, message handler, and entry handler.
 *
 * @module bootstrap/hooks-setup
 */

import type { Agent } from "../agent/index.js";
import type { LoadedTypeScriptHook } from "../hooks/types.js";
import {
	discoverAndLoadTypeScriptHooks,
	setGlobalAppendEntryHandler,
	setGlobalCwd,
	setGlobalSendHandler,
	setGlobalSendMessageHandler,
} from "../hooks/typescript-loader.js";
import type { SessionManager } from "../session/manager.js";

export interface HooksSetupResult {
	tsHooks: LoadedTypeScriptHook[];
	tsHookErrors: string[];
}

/**
 * Discover and load TypeScript hooks, then wire up global send/message/entry handlers.
 */
export async function initializeTypeScriptHooks(params: {
	agent: Agent;
	sessionManager: SessionManager;
	cwd: string;
}): Promise<HooksSetupResult> {
	const { agent, sessionManager, cwd } = params;

	setGlobalCwd(cwd);
	const { hooks: tsHooks, errors: tsHookErrors } =
		await discoverAndLoadTypeScriptHooks([], cwd);

	if (tsHooks.length > 0) {
		console.error(`[hooks] Loaded ${tsHooks.length} TypeScript hooks`);
	}
	if (tsHookErrors.length > 0) {
		console.error(
			`[hooks] Warning: ${tsHookErrors.length} hook loading errors`,
		);
	}

	// Wire up the send handler to allow hooks to inject messages
	setGlobalSendHandler((text, attachments) => {
		const message = {
			role: "user" as const,
			content: text,
			attachments,
			timestamp: Date.now(),
		};
		if (agent.state.isStreaming) {
			void agent.followUp(message);
		} else {
			void agent.prompt(text, attachments);
		}
	});

	setGlobalSendMessageHandler((message, triggerTurn) => {
		const hookMessage = {
			role: "hookMessage" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};
		const manager = sessionManager as SessionManager & {
			appendCustomMessageEntry?: (
				customType: string,
				content:
					| string
					| {
							type: string;
							text?: string;
							data?: string;
							mimeType?: string;
					  }[],
				display: boolean,
				details?: unknown,
			) => void;
		};
		manager.appendCustomMessageEntry?.(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		if (agent.state.isStreaming) {
			void agent.followUp(hookMessage);
			return;
		}
		agent.injectMessage(hookMessage);
		if (triggerTurn) {
			void agent.continue();
		}
	});

	setGlobalAppendEntryHandler((customType, data) => {
		const manager = sessionManager as SessionManager & {
			appendCustomEntry?: (type: string, payload?: unknown) => void;
		};
		if (manager.appendCustomEntry) {
			manager.appendCustomEntry(customType, data);
		} else {
			console.warn(
				`[hooks] appendEntry(${customType}) ignored (session manager does not support custom entries yet)`,
			);
		}
	});

	return { tsHooks, tsHookErrors };
}
