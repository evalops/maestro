/**
 * @fileoverview Headless Execution Command (maestro exec)
 *
 * This module implements the `maestro exec` command for headless/scripted
 * agent execution. It's designed for CI/CD pipelines, automation scripts,
 * and evaluation workflows where interactive terminal UI is not needed.
 *
 * ## Key Features
 *
 * - **JSONL Event Streaming**: Structured output for machine parsing (`--json`)
 * - **Schema Validation**: Validate assistant output against JSON Schema (`--output-schema`)
 * - **Output Capture**: Save final response to file (`--output-last-message`)
 * - **Session Persistence**: All executions are saved as resumable sessions
 * - **Multi-prompt Support**: Chain multiple prompts in a single execution
 *
 * ## Usage
 *
 * ```bash
 * # Basic execution
 * maestro exec "Summarize the README.md file"
 *
 * # With JSON output
 * maestro exec --json "List all TypeScript files"
 *
 * # With schema validation
 * maestro exec --output-schema schema.json "Generate config"
 *
 * # Save output to file
 * maestro exec --output-last-message result.txt "Generate report"
 * ```
 *
 * ## JSONL Event Types
 *
 * When `--json` is specified, structured JSONL events are streamed to stdout:
 *
 * | Event Type | Description |
 * |------------|-------------|
 * | `thread` (phase=`start`/`end`) | Execution begins/ends with metadata |
 * | `turn` (phase=`start`/`end`) | User or assistant turn lifecycle |
 * | `item` (subtype=`message_delta`) | Streaming text chunk |
 * | `item` (subtype=`message_complete`) | Final message text + metadata (usage, stopReason, model) |
 * | `item` (subtype=`tool_call`) | Tool invocation |
 * | `item` (subtype=`tool_result`) | Tool execution result |
 * | `item` (subtype=`approval`) | Approval request/decision |
 * | `error` | Error occurred |
 * | `done` | Final status event |
 *
 * @module cli/commands/exec
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import AjvModule, {
	Ajv as AjvClass,
	type AnySchema,
	type ValidateFunction,
} from "ajv";
import chalk from "chalk";
import type { Agent } from "../../agent/agent.js";
import { applySessionEndHooks } from "../../agent/session-lifecycle-hooks.js";
import type { AgentEvent } from "../../agent/types.js";
import { runUserPromptWithRecovery } from "../../agent/user-prompt-runtime.js";
import type { SessionManager } from "../../session/manager.js";
import { resolveDefaultExport } from "../../utils/module-interop.js";
import {
	JsonlEventWriter,
	createAgentJsonlAdapter,
	emitThreadEnd,
	emitThreadStart,
	emitUserTurn as emitUserTurnEvent,
} from "../jsonl-writer.js";

/** Prefix added to exec session summaries for identification */
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
		throw new Error("maestro exec requires at least one prompt");
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
			const AjvCtor = resolveDefaultExport<typeof AjvClass>(
				AjvModule,
				AjvClass,
			);
			const ajv = new AjvCtor({ allErrors: true, strict: false });
			const validate = ajv.compile(schema as AnySchema);
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
			await runUserPromptWithRecovery({
				agent: options.agent,
				sessionManager: options.sessionManager,
				cwd: process.cwd(),
				prompt: normalized,
				execute: () => options.agent.prompt(normalized),
			});
		}

		if (executedPrompts === 0) {
			throw new Error("maestro exec requires at least one non-empty prompt");
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
					`maestro exec session ${threadId} saved to ${options.sessionManager.getSessionFile()}`,
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
		await applySessionEndHooks({
			agent: options.agent,
			sessionManager: options.sessionManager,
			cwd: process.cwd(),
			reason: runStatus === "error" ? "error" : "complete",
		});
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
