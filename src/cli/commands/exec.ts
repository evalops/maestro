import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import AjvModule, { type ValidateFunction } from "ajv";
import chalk from "chalk";
import type { Agent } from "../../agent/agent.js";
import type { AgentEvent } from "../../agent/types.js";
import type { SessionManager } from "../../session/manager.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
	emitThreadEnd,
	emitThreadStart,
	emitUserTurn as emitUserTurnEvent,
} from "../jsonl-writer.js";

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

const timestamp = (): string => new Date().toISOString();

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
	const threadId = options.sessionManager.getSessionId();
	const jsonlWriter = new JsonlEventWriter(options.jsonl ?? false);
	emitThreadStart(jsonlWriter, threadId, {
		sandboxMode: options.sandboxMode,
		cwd: process.cwd(),
		sessionId: threadId,
	});

	let turnCounter = 0;
	const nextTurnId = () => `turn-${++turnCounter}`;
	let runStatus: "ok" | "error" = "ok";
	const adapter = createAgentJsonlAdapter(jsonlWriter, nextTurnId);

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
		adapter.handle(event);
	});

	const emitUserTurn = (text: string) => {
		emitUserTurnEvent(jsonlWriter, nextTurnId, text);
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
		const lastAssistantText = adapter.getLastAssistantText();
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
		jsonlWriter.emit({
			type: "error",
			message: (error as Error).message,
			timestamp: timestamp(),
			stack: (error as Error).stack,
		});
		throw error;
	} finally {
		emitThreadEnd(jsonlWriter, threadId, runStatus, threadId);
		jsonlWriter.emit({
			type: "done",
			status: runStatus,
			timestamp: timestamp(),
			sessionId: threadId,
		});
		options.sessionManager.saveSessionSummary(buildSummary(prompts, runStatus));
	}
}
