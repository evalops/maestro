import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import AjvModule, { type ValidateFunction } from "ajv";
import chalk from "chalk";
import type { Agent } from "../../agent/agent.js";
import type { AgentEvent, AppMessage, TextContent } from "../../agent/types.js";
import type { SessionManager } from "../../session/manager.js";

export const EXEC_SESSION_SUMMARY_PREFIX = "[exec]";

interface ExecCommandOptions {
	agent: Agent;
	sessionManager: SessionManager;
	prompts: string[];
	jsonl: boolean;
	sandboxMode?: string;
	outputSchema?: string;
	outputLastMessage?: string;
}

type ExecEvent =
	| {
			type: "thread";
			phase: "start" | "end";
			threadId: string;
			sessionId?: string;
			timestamp: string;
			sandbox?: string;
			cwd?: string;
	  }
	| {
			type: "turn";
			phase: "start" | "end";
			turnId: string;
			role: "user" | "assistant" | "tool";
			timestamp: string;
			text?: string;
	  }
	| {
			type: "item";
			subtype:
				| "message_delta"
				| "message_complete"
				| "tool_call"
				| "tool_result"
				| "approval";
			turnId?: string;
			timestamp: string;
			data?: unknown;
	  }
	| {
			type: "error";
			message: string;
			timestamp: string;
			stack?: string;
	  }
	| {
			type: "done";
			status: "ok" | "error";
			timestamp: string;
			sessionId?: string;
	  };

class ExecEventWriter {
	constructor(
		private readonly enabled: boolean,
		private readonly stream: NodeJS.WritableStream = process.stdout,
	) {}

	emit(event: ExecEvent): void {
		if (!this.enabled) {
			return;
		}
		this.stream.write(`${JSON.stringify(event)}\n`);
	}
}

function timestamp(): string {
	return new Date().toISOString();
}

function isTextChunk(chunk: unknown): chunk is TextContent {
	return (
		typeof chunk === "object" &&
		chunk !== null &&
		"type" in chunk &&
		(chunk as { type?: unknown }).type === "text" &&
		"text" in chunk &&
		typeof (chunk as { text?: unknown }).text === "string"
	);
}

function extractText(message: AppMessage | undefined): string {
	if (!message) {
		return "";
	}
	const content = (message as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts = content.filter(isTextChunk).map((chunk) => chunk.text);
		return parts.join("");
	}
	if (typeof content === "string") {
		return content;
	}
	return "";
}

function buildSummary(prompts: string[], status: "ok" | "error"): string {
	const baseSource =
		prompts
			.find((prompt) => prompt.trim().length > 0)
			?.replace(/\s+/g, " ")
			.trim() ?? "(resume)";
	const truncated =
		baseSource.length > 80 ? `${baseSource.slice(0, 77)}…` : baseSource;
	const statusLabel = status === "error" ? " (failed)" : "";
	return `${EXEC_SESSION_SUMMARY_PREFIX}${statusLabel} ${truncated}`.trim();
}

function resolveSchemaSource(source: string): {
	schema: unknown;
	label: string;
} {
	const trimmed = source.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return { schema: JSON.parse(trimmed), label: "inline" };
	}
	const absolute = isAbsolute(source) ? source : resolve(process.cwd(), source);
	if (!existsSync(absolute)) {
		throw new Error(`Schema file not found: ${absolute}`);
	}
	return {
		schema: JSON.parse(readFileSync(absolute, "utf8")),
		label: absolute,
	};
}

function ensureDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

export async function runExecCommand(
	options: ExecCommandOptions,
): Promise<void> {
	const prompts = options.prompts;
	if (!prompts.length) {
		throw new Error("composer exec requires at least one prompt");
	}
	const writer = new ExecEventWriter(options.jsonl ?? false);
	const threadId = options.sessionManager.getSessionId();
	writer.emit({
		type: "thread",
		phase: "start",
		threadId,
		sessionId: threadId,
		timestamp: timestamp(),
		sandbox: options.sandboxMode,
		cwd: process.cwd(),
	});

	let turnCounter = 0;
	const nextTurnId = () => `turn-${++turnCounter}`;
	let currentAssistantTurn: string | null = null;
	let lastAssistantText = "";
	let runStatus: "ok" | "error" = "ok";

	const schemaValidator: { validate: ValidateFunction; label: string } | null =
		(() => {
			if (!options.outputSchema) {
				return null;
			}
			const { schema, label } = resolveSchemaSource(options.outputSchema);
			const AjvCtor: new (options?: unknown) => unknown =
				(
					AjvModule as unknown as {
						default?: new (options?: unknown) => unknown;
					}
				).default ??
				(AjvModule as unknown as new (
					options?: unknown,
				) => unknown);
			const ajv = new AjvCtor({ allErrors: true, strict: false }) as {
				compile: (schema: unknown) => ValidateFunction;
			};
			const validate = ajv.compile(schema);
			return { validate, label };
		})();

	options.agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "message_start": {
				currentAssistantTurn = nextTurnId();
				writer.emit({
					type: "turn",
					phase: "start",
					role: "assistant",
					turnId: currentAssistantTurn,
					timestamp: timestamp(),
				});
				break;
			}
			case "message_update": {
				if (!currentAssistantTurn) {
					currentAssistantTurn = nextTurnId();
					writer.emit({
						type: "turn",
						phase: "start",
						role: "assistant",
						turnId: currentAssistantTurn,
						timestamp: timestamp(),
					});
				}
				writer.emit({
					type: "item",
					subtype: "message_delta",
					turnId: currentAssistantTurn,
					timestamp: timestamp(),
					data: { text: extractText(event.message) },
				});
				break;
			}
			case "message_end": {
				lastAssistantText = extractText(event.message);
				const turnId = currentAssistantTurn ?? nextTurnId();
				writer.emit({
					type: "item",
					subtype: "message_complete",
					turnId,
					timestamp: timestamp(),
					data: { text: lastAssistantText },
				});
				writer.emit({
					type: "turn",
					phase: "end",
					turnId,
					role: "assistant",
					timestamp: timestamp(),
				});
				currentAssistantTurn = null;
				break;
			}
			case "tool_execution_start": {
				writer.emit({
					type: "item",
					subtype: "tool_call",
					timestamp: timestamp(),
					data: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					},
				});
				break;
			}
			case "tool_execution_end": {
				writer.emit({
					type: "item",
					subtype: "tool_result",
					timestamp: timestamp(),
					data: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					},
				});
				break;
			}
			case "action_approval_required": {
				writer.emit({
					type: "item",
					subtype: "approval",
					timestamp: timestamp(),
					data: { request: event.request },
				});
				break;
			}
			case "action_approval_resolved": {
				writer.emit({
					type: "item",
					subtype: "approval",
					timestamp: timestamp(),
					data: { request: event.request, decision: event.decision },
				});
				break;
			}
			default:
				break;
		}
	});

	const emitUserTurn = (text: string) => {
		const turnId = nextTurnId();
		writer.emit({
			type: "turn",
			phase: "start",
			turnId,
			role: "user",
			timestamp: timestamp(),
			text,
		});
		writer.emit({
			type: "item",
			subtype: "message_complete",
			turnId,
			timestamp: timestamp(),
			data: { text },
		});
		writer.emit({
			type: "turn",
			phase: "end",
			turnId,
			role: "user",
			timestamp: timestamp(),
		});
	};

	let executedPrompts = 0;
	try {
		for (const prompt of prompts) {
			const normalized = prompt.trim();
			if (!normalized) {
				continue;
			}
			emitUserTurn(normalized);
			executedPrompts++;
			await options.agent.prompt(normalized);
		}

		if (executedPrompts === 0) {
			throw new Error("composer exec requires at least one non-empty prompt");
		}
		if (!lastAssistantText) {
			throw new Error("The assistant did not produce a response.");
		}

		if (schemaValidator) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(lastAssistantText);
			} catch (error) {
				throw new Error(
					`Assistant output is not valid JSON for schema ${schemaValidator.label}: ${(error as Error).message}`,
				);
			}
			if (!schemaValidator.validate(parsed)) {
				const detail = schemaValidator.validate.errors
					?.map(
						(err) => `${err.instancePath || "."} ${err.message ?? "failed"}`,
					)
					.join("; ");
				throw new Error(
					`Assistant output failed schema validation${detail ? `: ${detail}` : ""}`,
				);
			}
		}

		if (options.outputLastMessage) {
			const target = isAbsolute(options.outputLastMessage)
				? options.outputLastMessage
				: resolve(process.cwd(), options.outputLastMessage);
			ensureDir(target);
			writeFileSync(target, lastAssistantText, "utf8");
		}

		if (!options.jsonl) {
			console.log(lastAssistantText);
			console.error(
				chalk.dim(
					`composer exec session ${threadId} saved to ${options.sessionManager.getSessionFile()}`,
				),
			);
		}
	} catch (error) {
		runStatus = "error";
		writer.emit({
			type: "error",
			message: (error as Error).message,
			timestamp: timestamp(),
			stack: (error as Error).stack,
		});
		throw error;
	} finally {
		writer.emit({
			type: "thread",
			phase: "end",
			threadId,
			sessionId: threadId,
			timestamp: timestamp(),
		});
		writer.emit({
			type: "done",
			status: runStatus,
			timestamp: timestamp(),
			sessionId: threadId,
		});
		options.sessionManager.saveSessionSummary(buildSummary(prompts, runStatus));
	}
}
