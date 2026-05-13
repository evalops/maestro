import type {
	MaestroScriptedScenario,
	MaestroScriptedStatement,
} from "@evalops/contracts";
import { MAESTRO_SCRIPTED_SCENARIO_SCHEMA } from "@evalops/contracts";
import {
	readScenarioJsonSource,
	readScenarioJsonSourceSync,
	scenarioSourceLabel,
} from "../scenario-source.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
	ToolCall,
	ToolResultMessage,
} from "../types.js";

export const SCRIPTED_REPLAY_PROVIDER = "scripted-replay";
export const SCRIPTED_REPLAY_MODEL_ID = "maestro-replay-v1";

type ScriptedStatement = MaestroScriptedStatement;
type ScriptedScenario = MaestroScriptedScenario;

const scriptedScenarioSourceCache = new Map<
	string,
	Promise<ScriptedScenario>
>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScriptedScenario(
	value: unknown,
	label: string,
): ScriptedScenario {
	if (
		!isRecord(value) ||
		value.schemaVersion !== MAESTRO_SCRIPTED_SCENARIO_SCHEMA
	) {
		throw new Error(
			`Replay scenario ${label} must use schemaVersion ${MAESTRO_SCRIPTED_SCENARIO_SCHEMA}`,
		);
	}
	if (typeof value.id !== "string" || value.id.trim().length === 0) {
		throw new Error(`Replay scenario ${label} must contain a non-empty id`);
	}
	if (
		typeof value.description !== "string" ||
		value.description.trim().length === 0
	) {
		throw new Error(
			`Replay scenario ${label} must contain a non-empty description`,
		);
	}
	if (
		value.expectedOutcome !== undefined &&
		value.expectedOutcome !== "pass" &&
		value.expectedOutcome !== "fail"
	) {
		throw new Error(
			`Replay scenario ${label} expectedOutcome must be pass or fail`,
		);
	}
	if (!Array.isArray(value.frames)) {
		throw new Error(`Replay scenario ${label} must contain frames`);
	}
	if (!isRecord(value.metadata)) {
		throw new Error(`Replay scenario ${label} must contain metadata`);
	}
	if (
		typeof value.metadata.recordedAt !== "string" ||
		value.metadata.recordedAt.trim().length === 0
	) {
		throw new Error(
			`Replay scenario ${label} metadata.recordedAt must be a non-empty string`,
		);
	}
	if (!Array.isArray(value.metadata.toolsExpected)) {
		throw new Error(
			`Replay scenario ${label} metadata.toolsExpected must be an array`,
		);
	}
	for (const [toolOffset, toolName] of value.metadata.toolsExpected.entries()) {
		if (typeof toolName !== "string" || toolName.trim().length === 0) {
			throw new Error(
				`Replay scenario ${label} metadata.toolsExpected[${toolOffset}] must be a non-empty string`,
			);
		}
	}
	if (
		value.metadata.auditEvents !== undefined &&
		!Array.isArray(value.metadata.auditEvents)
	) {
		throw new Error(
			`Replay scenario ${label} metadata.auditEvents must be an array`,
		);
	}
	for (const [eventOffset, eventType] of (
		value.metadata.auditEvents ?? []
	).entries()) {
		if (typeof eventType !== "string" || eventType.trim().length === 0) {
			throw new Error(
				`Replay scenario ${label} metadata.auditEvents[${eventOffset}] must be a non-empty string`,
			);
		}
	}
	if (value.assertions !== undefined && !Array.isArray(value.assertions)) {
		throw new Error(`Replay scenario ${label} assertions must be an array`);
	}
	for (const [assertionOffset, assertion] of (
		value.assertions ?? []
	).entries()) {
		if (
			!isRecord(assertion) ||
			typeof assertion.id !== "string" ||
			typeof assertion.kind !== "string"
		) {
			throw new Error(
				`Replay scenario ${label} assertion ${assertionOffset} must contain id and kind`,
			);
		}
		if (
			![
				"tool_called",
				"tool_not_called",
				"file_exists",
				"file_contents",
				"audit_event_emitted",
			].includes(assertion.kind)
		) {
			throw new Error(
				`Replay scenario ${label} assertion ${assertion.id} has unknown kind ${assertion.kind}`,
			);
		}
	}
	for (const [frameOffset, frame] of value.frames.entries()) {
		if (
			!isRecord(frame) ||
			!Number.isInteger(frame.index) ||
			!Array.isArray(frame.statements)
		) {
			throw new Error(
				`Replay scenario ${label} frame ${frameOffset} must contain index and statements`,
			);
		}
		if (frame.index !== frameOffset) {
			throw new Error(
				`Replay scenario ${label} frame indexes must be contiguous, unique, and start at 0; frame ${frameOffset} has index ${frame.index}`,
			);
		}
		for (const [statementOffset, statement] of frame.statements.entries()) {
			if (!isRecord(statement) || typeof statement.kind !== "string") {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} must contain kind`,
				);
			}
			if (statement.kind === "text" && typeof statement.text !== "string") {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} text must be a string`,
				);
			}
			if (
				statement.kind === "delay" &&
				(typeof statement.ms !== "number" ||
					!Number.isFinite(statement.ms) ||
					statement.ms < 0)
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} delay ms must be non-negative`,
				);
			}
			if (
				statement.kind === "tool_call" &&
				(typeof statement.tool !== "string" ||
					statement.tool.trim().length === 0)
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} tool_call tool must be a non-empty string`,
				);
			}
			if (
				statement.kind === "tool_call" &&
				statement.id !== undefined &&
				typeof statement.id !== "string"
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} tool_call id must be a string`,
				);
			}
			if (
				statement.kind === "tool_call" &&
				statement.expectedResult !== undefined &&
				statement.expectedResult !== "success" &&
				statement.expectedResult !== "error" &&
				statement.expectedResult !== "any"
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} expectedResult must be success, error, or any`,
				);
			}
			if (statement.kind === "error") {
				if (statement.type !== "transient" && statement.type !== "fatal") {
					throw new Error(
						`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} error type must be transient or fatal`,
					);
				}
				if (typeof statement.message !== "string") {
					throw new Error(
						`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} error message must be a string`,
					);
				}
			}
			if (
				statement.kind === "end" &&
				statement.reason !== "complete" &&
				statement.reason !== "aborted" &&
				statement.reason !== "limit_exceeded"
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} end reason is invalid`,
				);
			}
			if (
				![
					"text",
					"delay",
					"tool_call",
					"error",
					"wait_for_user",
					"end",
				].includes(statement.kind)
			) {
				throw new Error(
					`Replay scenario ${label} frame ${frame.index} statement ${statementOffset} has unknown kind ${statement.kind}`,
				);
			}
		}
	}
	return value as unknown as ScriptedScenario;
}

export function loadScriptedScenario(path: string): ScriptedScenario {
	return parseScriptedScenario(readScenarioJsonSourceSync(path), path);
}

export async function loadScriptedScenarioFromSource(
	source: string,
): Promise<ScriptedScenario> {
	let pending = scriptedScenarioSourceCache.get(source);
	if (!pending) {
		const label = scenarioSourceLabel(source);
		pending = readScenarioJsonSource(source).then((value) =>
			parseScriptedScenario(value, label),
		);
		scriptedScenarioSourceCache.set(source, pending);
	}
	try {
		return await pending;
	} catch (error) {
		scriptedScenarioSourceCache.delete(source);
		throw error;
	}
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function scriptedAssistantMessage(_model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "scripted-replay",
		provider: SCRIPTED_REPLAY_PROVIDER,
		model: SCRIPTED_REPLAY_MODEL_ID,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replayFrameIndex(context: Context): number {
	return context.messages.filter(
		(message) =>
			message.role === "assistant" &&
			message.provider === SCRIPTED_REPLAY_PROVIDER,
	).length;
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return isRecord(value) && value.role === "toolResult";
}

function expectedToolResultError(
	scenario: ScriptedScenario,
	frameIndex: number,
	context: Context,
): string | undefined {
	if (frameIndex <= 0) return undefined;
	const previousFrame = scenario.frames.find(
		(candidate) => candidate.index === frameIndex - 1,
	);
	if (!previousFrame) return undefined;
	for (const [
		statementIndex,
		statement,
	] of previousFrame.statements.entries()) {
		if (
			statement.kind !== "tool_call" ||
			statement.expectedResult === undefined ||
			statement.expectedResult === "any"
		) {
			continue;
		}
		const callId = toolCallId(
			scenario,
			previousFrame.index,
			statementIndex,
			statement,
		);
		let toolResult: ToolResultMessage | undefined;
		for (let offset = context.messages.length - 1; offset >= 0; offset -= 1) {
			const message = context.messages[offset];
			if (
				isToolResultMessage(message) &&
				message.toolCallId === callId &&
				message.toolName === statement.tool
			) {
				toolResult = message;
				break;
			}
		}
		if (!toolResult) {
			return `Scripted replay expected ${statement.expectedResult} result for tool call ${callId}, but no matching tool result was present.`;
		}
		const observed = toolResult.isError ? "error" : "success";
		if (observed !== statement.expectedResult) {
			return `Scripted replay expected ${statement.expectedResult} result for tool call ${callId}, but observed ${observed}.`;
		}
	}
	return undefined;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
	return isRecord(input) ? input : {};
}

function toolCallId(
	scenario: ScriptedScenario,
	frameIndex: number,
	statementIndex: number,
	statement: Extract<ScriptedStatement, { kind: "tool_call" }>,
): string {
	return (
		statement.id ??
		`replay_${scenario.id}_${String(frameIndex).padStart(3, "0")}_${String(
			statementIndex,
		).padStart(3, "0")}`
	);
}

function scriptedErrorMessage(
	statement: Extract<ScriptedStatement, { kind: "error" }>,
): string {
	if (
		statement.type !== "transient" ||
		/\btry again\b/i.test(statement.message)
	) {
		return statement.message;
	}
	return `${statement.message} Try again.`;
}

function abortError(): Error {
	const error = new Error("Scripted replay aborted");
	error.name = "AbortError";
	return error;
}

function checkAbort(
	signal: AbortSignal | undefined,
	partial: AssistantMessage,
): void {
	if (!signal?.aborted) return;
	partial.stopReason = "aborted";
	throw abortError();
}

async function sleep(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolveSleep, reject) => {
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};
		const timeout = setTimeout(() => {
			cleanup();
			resolveSleep();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(abortError());
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function* streamScriptedReplay(
	model: Model<Api>,
	context: Context,
	options: StreamOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const scenarioPath = process.env.MAESTRO_SCENARIO_PATH;
	if (!scenarioPath) {
		throw new Error("MAESTRO_SCENARIO_PATH is required for scripted replay.");
	}

	const scenario = await loadScriptedScenarioFromSource(scenarioPath);
	const frameIndex = replayFrameIndex(context);
	const frame = scenario.frames.find(
		(candidate) => candidate.index === frameIndex,
	);
	const partial = scriptedAssistantMessage(model);

	yield { type: "start", partial };

	const expectationError = expectedToolResultError(
		scenario,
		frameIndex,
		context,
	);
	if (expectationError) {
		partial.stopReason = "error";
		partial.errorMessage = expectationError;
		yield { type: "error", reason: "error", error: partial };
		return;
	}

	if (!frame) {
		const contentIndex = partial.content.length;
		const text = `Scripted scenario ${scenario.id} complete.`;
		partial.content.push({ type: "text", text: "" });
		yield { type: "text_start", contentIndex, partial };
		const block = partial.content[contentIndex];
		if (block?.type === "text") {
			block.text = text;
		}
		yield { type: "text_delta", contentIndex, delta: text, partial };
		yield { type: "text_end", contentIndex, content: text, partial };
		yield { type: "done", reason: "stop", message: partial };
		return;
	}

	let emittedToolCall = false;
	let endedByTerminalStatement = false;
	try {
		for (const [statementIndex, statement] of frame.statements.entries()) {
			checkAbort(options.signal, partial);
			if (statement.kind === "delay") {
				await sleep(statement.ms, options.signal);
				continue;
			}
			if (statement.kind === "text") {
				const contentIndex = partial.content.length;
				partial.content.push({ type: "text", text: "" });
				yield { type: "text_start", contentIndex, partial };
				const block = partial.content[contentIndex];
				if (block?.type !== "text") continue;
				const delayPerChar =
					statement.streamMs && statement.text.length > 0
						? Math.max(
								0,
								Math.floor(statement.streamMs / statement.text.length),
							)
						: 0;
				for (const char of statement.text) {
					checkAbort(options.signal, partial);
					if (delayPerChar > 0) {
						await sleep(delayPerChar, options.signal);
					}
					block.text += char;
					yield {
						type: "text_delta",
						contentIndex,
						delta: char,
						partial,
					};
				}
				yield {
					type: "text_end",
					contentIndex,
					content: block.text,
					partial,
				};
				continue;
			}
			if (statement.kind === "tool_call") {
				const contentIndex = partial.content.length;
				const call: ToolCall = {
					type: "toolCall",
					id: toolCallId(scenario, frame.index, statementIndex, statement),
					name: statement.tool,
					arguments: normalizeToolInput(statement.input),
				};
				partial.content.push(call);
				yield { type: "toolcall_start", contentIndex, partial };
				yield {
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(call.arguments),
					partial,
				};
				yield { type: "toolcall_end", contentIndex, toolCall: call, partial };
				emittedToolCall = true;
				continue;
			}
			if (statement.kind === "error") {
				partial.stopReason = "error";
				partial.errorMessage = scriptedErrorMessage(statement);
				yield { type: "error", reason: "error", error: partial };
				return;
			}
			if (statement.kind === "wait_for_user") {
				endedByTerminalStatement = true;
				partial.stopReason = "stop";
				break;
			}
			if (statement.kind === "end") {
				endedByTerminalStatement = true;
				partial.stopReason =
					statement.reason === "limit_exceeded"
						? "length"
						: statement.reason === "aborted"
							? "aborted"
							: "stop";
				if (partial.stopReason === "aborted") {
					yield { type: "error", reason: "aborted", error: partial };
					return;
				}
				break;
			}
		}
		if (emittedToolCall && !endedByTerminalStatement) {
			partial.stopReason = "toolUse";
		}
		yield {
			type: "done",
			reason:
				partial.stopReason === "length"
					? "length"
					: partial.stopReason === "toolUse"
						? "toolUse"
						: "stop",
			message: partial,
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
			return;
		}
		throw error;
	}
}
