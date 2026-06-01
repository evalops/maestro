import * as logger from "./logger.js";
import {
	type PlatformRuntimeEventResult,
	type SlackRuntimeEventOptions,
	type SlackRuntimeEventType,
	recordSlackAgentRuntimeEvent,
} from "./platform-runtime.js";
import type { SlackContext } from "./slack/bot.js";

type RuntimeEventAttributes = Record<
	string,
	string | number | boolean | null | undefined
>;

type RuntimeEventWriter = (
	ctx: SlackContext,
	options: SlackRuntimeEventOptions,
) => Promise<PlatformRuntimeEventResult | null>;

export interface RuntimeEventRecorder {
	record: (
		type: SlackRuntimeEventType,
		message: string,
		attributes?: RuntimeEventAttributes,
	) => Promise<void>;
	flush: () => Promise<void>;
}

export interface RuntimeEventRecorderOptions {
	writeEvent?: RuntimeEventWriter;
	logWarning?: (message: string, detail: string) => void;
}

export function createRuntimeEventRecorder(
	ctx: SlackContext,
	runId: string | undefined,
	options: RuntimeEventRecorderOptions = {},
): RuntimeEventRecorder {
	if (!runId) {
		return {
			record: async () => undefined,
			flush: async () => undefined,
		};
	}

	const writeEvent = options.writeEvent ?? recordSlackAgentRuntimeEvent;
	const logWarning = options.logWarning ?? logger.logWarning;
	let tail: Promise<void> = Promise.resolve();

	const record: RuntimeEventRecorder["record"] = (
		type,
		message,
		attributes,
	) => {
		const task = tail.then(async () => {
			try {
				await writeEvent(ctx, {
					runId,
					type,
					message,
					attributes: compactRuntimeAttributes(attributes),
				});
			} catch (error) {
				logWarning(
					"Platform AgentRuntime event recording skipped",
					error instanceof Error ? error.message : String(error),
				);
			}
		});
		tail = task.catch(() => undefined);
		return task;
	};

	return {
		record,
		flush: () => tail,
	};
}

function compactRuntimeAttributes(
	attributes: RuntimeEventAttributes | undefined,
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(attributes ?? {})) {
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed) {
				result[key] = trimmed;
			}
			continue;
		}
		result[key] = value;
	}
	return result;
}
