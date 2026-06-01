import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "../../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentRunConfig,
	AgentTransport,
	AssistantMessage,
	Message,
	Model,
	ToolPhaseSummary,
	UserMessage,
} from "../../../src/agent/types.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export const BATCH_SHAPING_REPLAY_SCHEMA =
	"evalops.maestro.batch-shaping-replay.v1";

export const BATCH_SHAPING_FEEDBACK_HINT =
	"When you need several independent reads or searches, emit them together in one assistant message so Maestro can batch them safely.";

export interface BatchShapingToolSpec {
	toolName: string;
	args: Record<string, unknown>;
}

export interface BatchShapingReplayTurn {
	promptMessages: string[];
	emittedToolCalls: BatchShapingToolSpec[];
}

export interface BatchShapingReplayFixture {
	baseline: BatchShapingReplayTurn;
	nudged: BatchShapingReplayTurn;
}

export interface BatchShapingReplayMetrics {
	schemaVersion: typeof BATCH_SHAPING_REPLAY_SCHEMA;
	modelToolCallCount: number;
	multiCallTurns: number;
	parallelizedCallCount: number;
	serializedCallCount: number;
	topSerializationReasons: Array<{ reason: string; count: number }>;
}

export interface BatchShapingEvalActual {
	baseline: BatchShapingReplayMetrics;
	nudged: BatchShapingReplayMetrics;
	improvement: {
		modelToolCallCountDelta: number;
		multiCallTurnDelta: number;
		increasedMultiCallTurns: boolean;
	};
	privacy: {
		safe: boolean;
		disallowedSubstringCount: number;
	};
	runtime: {
		exercisedAgentToolPhaseSummary: boolean;
		promptOnlyFeedbackDelivered: boolean;
		observedToolPhaseSummaryCount: number;
	};
}

export interface BatchShapingEvalCase {
	name: string;
	userIntent: string;
	replays?: BatchShapingReplayFixture;
	expectedIndependentCalls?: BatchShapingToolSpec[];
	sensitiveSubstrings?: string[];
	expected: Partial<BatchShapingEvalActual>;
}

export type BatchShapingEvalResult = EvalSuiteResult<
	BatchShapingEvalCase,
	BatchShapingEvalActual
>;

const DEFAULT_CASES_PATH = "evals/tools/batch-shaping-cases.json";

export function getBatchShapingEvalCasesPath(): string {
	return process.env.BATCH_SHAPING_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadBatchShapingEvalCases(
	casesPath = getBatchShapingEvalCasesPath(),
): BatchShapingEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
	return Array.isArray(parsed) ? (parsed as BatchShapingEvalCase[]) : [];
}

const EVAL_MODEL: Model<"openai-completions"> = {
	id: "batch-shaping-eval-model",
	name: "Batch shaping eval model",
	provider: "eval",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 1024,
};

export async function evaluateBatchShapingCaseOutput(
	testCase: BatchShapingEvalCase,
): Promise<BatchShapingEvalActual> {
	const replay = resolveReplayFixture(testCase);
	const runtime = await replayBatchShapeThroughAgent(replay, testCase.userIntent);
	const { baseline, nudged } = runtime;
	const reportWithoutPrivacy = {
		baseline,
		nudged,
		improvement: {
			modelToolCallCountDelta:
				nudged.modelToolCallCount - baseline.modelToolCallCount,
			multiCallTurnDelta: nudged.multiCallTurns - baseline.multiCallTurns,
			increasedMultiCallTurns: nudged.multiCallTurns > baseline.multiCallTurns,
		},
	};

	return {
		...reportWithoutPrivacy,
		privacy: privacySummary(reportWithoutPrivacy, testCase),
		runtime: {
			exercisedAgentToolPhaseSummary:
				runtime.observedToolPhaseSummaryCount >= 2,
			promptOnlyFeedbackDelivered: runtime.promptOnlyFeedbackDelivered,
			observedToolPhaseSummaryCount: runtime.observedToolPhaseSummaryCount,
		},
	};
}

export async function runBatchShapingEvalCase(
	testCase: BatchShapingEvalCase,
): Promise<BatchShapingEvalResult> {
	const actual = await evaluateBatchShapingCaseOutput(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export async function runBatchShapingEvalSuite(
	cases: BatchShapingEvalCase[],
): Promise<BatchShapingEvalResult[]> {
	const results: BatchShapingEvalResult[] = [];
	for (const testCase of cases) {
		results.push(await runBatchShapingEvalCase(testCase));
	}
	return results;
}

export function summarizeBatchShapingEvalResults(
	results: BatchShapingEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

function resolveReplayFixture(
	testCase: BatchShapingEvalCase,
): BatchShapingReplayFixture {
	if (testCase.replays) {
		return testCase.replays;
	}

	const expectedIndependentCalls = testCase.expectedIndependentCalls ?? [];
	return {
		baseline: {
			promptMessages: [testCase.userIntent],
			emittedToolCalls: expectedIndependentCalls.slice(0, 1),
		},
		nudged: {
			promptMessages: [testCase.userIntent, BATCH_SHAPING_FEEDBACK_HINT],
			emittedToolCalls: expectedIndependentCalls,
		},
	};
}

interface AgentReplayMetrics {
	baseline: BatchShapingReplayMetrics;
	nudged: BatchShapingReplayMetrics;
	promptOnlyFeedbackDelivered: boolean;
	observedToolPhaseSummaryCount: number;
}

async function replayBatchShapeThroughAgent(
	replay: BatchShapingReplayFixture,
	userIntent: string,
): Promise<AgentReplayMetrics> {
	const transport = new BatchShapingEvalTransport(replay);
	const observedToolPhaseSummaries: ToolPhaseSummary[] = [];
	const agent = new Agent({
		transport,
		initialState: {
			model: EVAL_MODEL,
			tools: [],
		},
	});
	agent.subscribe((event) => {
		if (event.type === "tool_phase_summary") {
			observedToolPhaseSummaries.push(event);
		}
	});

	await agent.prompt(userIntent);

	if (!transport.baseline || !transport.nudged) {
		throw new Error("Batch-shaping eval transport did not emit both phases");
	}

	return {
		baseline: transport.baseline,
		nudged: transport.nudged,
		promptOnlyFeedbackDelivered: transport.promptOnlyFeedbackDelivered,
		observedToolPhaseSummaryCount: observedToolPhaseSummaries.length,
	};
}

class BatchShapingEvalTransport implements AgentTransport {
	public baseline?: BatchShapingReplayMetrics;
	public nudged?: BatchShapingReplayMetrics;
	public promptOnlyFeedbackDelivered = false;

	constructor(private readonly replay: BatchShapingReplayFixture) {}

	async *continue(): AsyncGenerator<AgentEvent, void, unknown> {}

	async *run(
		_messages: Message[],
		userMessage: UserMessage,
		config: AgentRunConfig,
	): AsyncGenerator<AgentEvent, void, unknown> {
		yield { type: "message_start", message: userMessage };
		yield { type: "message_end", message: userMessage };

		const baselineSummary = buildToolPhaseSummary(
			this.replay.baseline,
			true,
		);
		this.baseline = toolPhaseSummaryToMetrics(baselineSummary);
		yield baselineSummary;

		const promptOnlyMessages = (await config.getPromptOnlyMessages?.()) ?? [];
		this.promptOnlyFeedbackDelivered = promptOnlyMessages.some((message) =>
			messageText(message).includes(BATCH_SHAPING_FEEDBACK_HINT),
		);

		const nudgedReplay = this.promptOnlyFeedbackDelivered
			? this.replay.nudged
			: this.replay.baseline;
		const nudgedSummary = buildToolPhaseSummary(nudgedReplay, false);
		this.nudged = toolPhaseSummaryToMetrics(nudgedSummary);
		yield nudgedSummary;

		const finalAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Batch-shaping eval complete." }],
			api: "openai-completions",
			provider: "eval",
			model: EVAL_MODEL.id,
			usage: {
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
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		yield { type: "message_start", message: finalAssistant };
		yield { type: "message_end", message: finalAssistant };
	}
}

function buildToolPhaseSummary(
	replay: BatchShapingReplayTurn,
	includeFeedback: boolean,
): ToolPhaseSummary {
	const modelToolCallCount = replay.emittedToolCalls.length;
	const multiCallTurn = modelToolCallCount > 1;
	const decisions = replay.emittedToolCalls.map((toolCall, emittedIndex) => {
		const outcome = multiCallTurn ? "parallelized" : "serialized";
		const reason = multiCallTurn
			? "read_only_parallel_safe"
			: "single_read_only_call";
		return {
			toolCallId: `eval_tool_${emittedIndex}`,
			toolName: toolCall.toolName,
			emittedIndex,
			outcome,
			decision: outcome,
			reason,
			waveIndex: 0,
			waitMs: 0,
			schedulerWaitMs: 0,
		};
	});
	const serializedCallCount = multiCallTurn ? 0 : modelToolCallCount;
	const serializationReasons =
		serializedCallCount > 0
			? { single_read_only_call: serializedCallCount }
			: {};

	return {
		type: "tool_phase_summary",
		modelToolCallCount,
		modelEmittedToolCallCount: modelToolCallCount,
		schedulableWaveCount: modelToolCallCount > 0 ? 1 : 0,
		parallelizedCallCount: multiCallTurn ? modelToolCallCount : 0,
		actuallyParallelizedCallCount: multiCallTurn ? modelToolCallCount : 0,
		serializedCallCount,
		delayedCallCount: 0,
		blockedByMutationCount: 0,
		mcpOptInCallCount: 0,
		mcpOptInUseCount: 0,
		cacheHitCount: 0,
		totalToolWaitMs: 0,
		toolWaitTimeMs: 0,
		serializationReasons,
		decisions,
		batchShapingFeedback:
			includeFeedback && modelToolCallCount === 1
				? {
						avoidableSingleton: true,
						reason: "single_read_only_call",
						hint: BATCH_SHAPING_FEEDBACK_HINT,
					}
				: undefined,
	};
}

function toolPhaseSummaryToMetrics(
	summary: ToolPhaseSummary,
): BatchShapingReplayMetrics {
	return {
		schemaVersion: BATCH_SHAPING_REPLAY_SCHEMA,
		modelToolCallCount: summary.modelToolCallCount,
		multiCallTurns: summary.modelToolCallCount > 1 ? 1 : 0,
		parallelizedCallCount: summary.parallelizedCallCount,
		serializedCallCount: summary.serializedCallCount,
		topSerializationReasons: Object.entries(summary.serializationReasons).map(
			([reason, count]) => ({ reason, count }),
		),
	};
}

function messageText(message: Message): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
	}
	return "";
}

function privacySummary(
	report: Omit<BatchShapingEvalActual, "privacy" | "runtime">,
	testCase: BatchShapingEvalCase,
): BatchShapingEvalActual["privacy"] {
	const disallowedSubstrings = testCase.sensitiveSubstrings ?? [];
	const serialized = JSON.stringify(report);
	return {
		safe: disallowedSubstrings.every(
			(substring) => substring.length === 0 || !serialized.includes(substring),
		),
		disallowedSubstringCount: disallowedSubstrings.length,
	};
}
