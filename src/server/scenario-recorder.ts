import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MAESTRO_SCRIPTED_SCENARIO_SCHEMA } from "@evalops/contracts";
import type { AssistantMessage, ToolCall } from "../agent/types.js";

export interface ScriptedScenarioRecorderOptions {
	outPath: string;
	recordedFrom?: () => string | undefined;
	recordedAt?: string;
	modelOriginal?: string;
}

type ScriptedRecordedStatement =
	| { kind: "text"; text: string }
	| {
			kind: "tool_call";
			tool: string;
			input: Record<string, unknown>;
			id?: string;
			expectedResult: "any";
	  }
	| { kind: "error"; type: "fatal"; message: string }
	| { kind: "end"; reason: "complete" | "aborted" | "limit_exceeded" };

interface ScriptedRecordedFrame {
	index: number;
	statements: ScriptedRecordedStatement[];
}

interface ScriptedRecordedScenario {
	schemaVersion: typeof MAESTRO_SCRIPTED_SCENARIO_SCHEMA;
	id: string;
	description: string;
	metadata: {
		recordedFrom?: string;
		recordedAt: string;
		modelOriginal?: string;
		toolsExpected: string[];
	};
	frames: ScriptedRecordedFrame[];
}

function scenarioIdFromPath(path: string): string {
	const filename = path
		.split(/[\\/]/)
		.at(-1)
		?.replace(/\.[^.]+$/, "");
	return (
		filename
			?.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "recorded-scenario"
	);
}

function normalizeToolArguments(
	value: ToolCall["arguments"],
): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function endReason(
	message: AssistantMessage,
): "complete" | "aborted" | "limit_exceeded" {
	if (message.stopReason === "length") return "limit_exceeded";
	if (message.stopReason === "aborted") return "aborted";
	return "complete";
}

export class ScriptedScenarioRecorder {
	private readonly outPath: string;
	private readonly recordedFrom?: () => string | undefined;
	private readonly recordedAt: string;
	private modelOriginal?: string;
	private readonly scenarioId: string;
	private readonly frames: ScriptedRecordedFrame[] = [];

	constructor(options: ScriptedScenarioRecorderOptions) {
		this.outPath = resolve(options.outPath);
		this.recordedFrom = options.recordedFrom;
		this.recordedAt = options.recordedAt ?? new Date().toISOString();
		this.modelOriginal = options.modelOriginal;
		this.scenarioId = scenarioIdFromPath(this.outPath);
		this.write();
	}

	getOutputPath(): string {
		return this.outPath;
	}

	recordAssistantMessage(message: AssistantMessage): void {
		if (!this.modelOriginal && message.model) {
			this.modelOriginal = `${message.provider}/${message.model}`;
		}

		const statements: ScriptedRecordedStatement[] = [];
		let hasToolCall = false;
		for (const block of message.content) {
			if (block.type === "text" && block.text.length > 0) {
				statements.push({ kind: "text", text: block.text });
			}
			if (block.type === "toolCall") {
				hasToolCall = true;
				const statement: ScriptedRecordedStatement = {
					kind: "tool_call",
					tool: block.name,
					input: normalizeToolArguments(block.arguments),
					expectedResult: "any",
				};
				if (block.id) {
					statement.id = block.id;
				}
				statements.push(statement);
			}
		}

		if (message.stopReason === "error") {
			statements.push({
				kind: "error",
				type: "fatal",
				message: message.errorMessage ?? "Recorded assistant error",
			});
		} else if (
			!hasToolCall ||
			message.stopReason === "stop" ||
			message.stopReason === "length" ||
			message.stopReason === "aborted"
		) {
			statements.push({ kind: "end", reason: endReason(message) });
		}

		this.frames.push({
			index: this.frames.length,
			statements,
		});
		this.write();
	}

	toScenario(): ScriptedRecordedScenario {
		const metadata: ScriptedRecordedScenario["metadata"] = {
			recordedAt: this.recordedAt,
			toolsExpected: Array.from(
				new Set(
					this.frames.flatMap((frame) =>
						frame.statements
							.filter((statement) => statement.kind === "tool_call")
							.map((statement) => statement.tool),
					),
				),
			),
		};
		const recordedFrom = this.recordedFrom?.();
		if (recordedFrom) {
			metadata.recordedFrom = recordedFrom;
		}
		if (this.modelOriginal) {
			metadata.modelOriginal = this.modelOriginal;
		}
		return {
			schemaVersion: MAESTRO_SCRIPTED_SCENARIO_SCHEMA,
			id: this.scenarioId,
			description: `Recorded Maestro scenario ${this.scenarioId}`,
			metadata,
			frames: this.frames,
		};
	}

	private write(): void {
		mkdirSync(dirname(this.outPath), { recursive: true });
		writeFileSync(
			this.outPath,
			`${JSON.stringify(this.toScenario(), null, 2)}\n`,
		);
	}
}
