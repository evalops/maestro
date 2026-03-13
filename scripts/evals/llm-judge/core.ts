import { inspect } from "node:util";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
	AssistantMessage,
	Context,
	Model,
	UserMessage,
} from "../../../src/agent/types.js";

type StreamOpenAIFn = typeof import("../../../src/agent/providers/openai.js").streamOpenAI;
type GetModelFn = typeof import("../../../src/models/builtin.js").getModel;
type LookupApiKeyFn = typeof import("../../../src/providers/api-keys.js").lookupApiKey;
type AgentCtor = typeof import("../../../src/agent/agent.js").Agent;
type ProviderTransportCtor = typeof import("../../../src/agent/transport.js").ProviderTransport;

interface JudgeRuntimeModules {
	streamOpenAI: StreamOpenAIFn;
	getModel: GetModelFn;
	lookupApiKey: LookupApiKeyFn;
	Agent: AgentCtor;
	ProviderTransport: ProviderTransportCtor;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..", "..", "..");
let judgeRuntimePromise: Promise<JudgeRuntimeModules> | null = null;

const DEFAULT_JUDGE_PROVIDER = "openrouter";
const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_VERIFY_PROVIDER = "openrouter";
const DEFAULT_VERIFY_MODEL = "anthropic/claude-opus-4.5";
const DEFAULT_MIN_SCORE = 0.75;
const DEFAULT_REPEAT = 1;

const PRIMARY_JUDGE_SYSTEM_PROMPT = [
	"You are grading Composer regression outputs.",
	"Explain the evidence before deciding pass or fail.",
	"A passing result must satisfy the rubric, match the observed output, and avoid contradictions.",
	"Penalize invented success, missing required behavior, misleading claims, or outputs that only partially satisfy the rubric.",
	"Reserve scores near 1.0 for outputs that are clearly correct and complete.",
	'Return a JSON object with keys reasoningText (string), passVerdict ("pass"|"fail"), qualityScore (number 0-1), issueList (string[]), and strengthList (string[]).',
	"Return only the requested JSON object.",
].join("\n");

const VERIFIER_SYSTEM_PROMPT = [
	"You are a second-pass verifier for another evaluation judge.",
	"Review the case, rubric, observed output, and the initial judgment.",
	"Confirm the verdict only if the reasoning is grounded in the observed output.",
	"If the initial judge was too lenient or too harsh, correct it conservatively.",
	'Return a JSON object with keys reasoningText (string), verdictAgreement ("agree"|"disagree"), verifiedPassVerdict ("pass"|"fail"), verifiedQualityScore (number 0-1), and criticalIssueList (string[]).',
	"Return only the requested JSON object.",
].join("\n");

export const LlmJudgeVerdictSchema = Type.Object(
	{
		reasoningText: Type.String({ minLength: 1 }),
		passVerdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
		qualityScore: Type.Number({ minimum: 0, maximum: 1 }),
		issueList: Type.Array(Type.String()),
		strengthList: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export const LlmJudgeVerificationSchema = Type.Object(
	{
		reasoningText: Type.String({ minLength: 1 }),
		verdictAgreement: Type.Union([
			Type.Literal("agree"),
			Type.Literal("disagree"),
		]),
		verifiedPassVerdict: Type.Union([
			Type.Literal("pass"),
			Type.Literal("fail"),
		]),
		verifiedQualityScore: Type.Number({ minimum: 0, maximum: 1 }),
		criticalIssueList: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export type LlmJudgeVerdict = Static<typeof LlmJudgeVerdictSchema>;
export type LlmJudgeVerification = Static<typeof LlmJudgeVerificationSchema>;

export interface JudgeModelConfig {
	provider: string;
	model: string;
	label?: string;
	temperature?: number;
}

export interface LlmJudgeRuntimeConfig {
	judge: JudgeModelConfig;
	verifier: JudgeModelConfig;
	repeat: number;
	minScore: number;
}

export interface LlmJudgeCaseInput {
	suiteName: string;
	caseName: string;
	rubric: string;
	observedOutput: unknown;
	scenarioSummary?: string;
	expectedSubset?: unknown;
	deterministicPass?: boolean;
	deterministicMismatch?: string | null;
}

export interface VerifiedJudgePair {
	label: string;
	judgeModel: JudgeModelConfig;
	verifierModel: JudgeModelConfig;
	judge: LlmJudgeVerdict;
	verification: LlmJudgeVerification;
	effectiveQualityScore: number;
	qualityPass: boolean;
	finalPassVerdict: "pass" | "fail";
	pass: boolean;
}

export interface VerifiedJudgeResult {
	input: LlmJudgeCaseInput;
	pairs: VerifiedJudgePair[];
	passedVotes: number;
	failedVotes: number;
	averageQualityScore: number;
	finalPassVerdict: "pass" | "fail";
	pass: boolean;
}

export interface VerifiedJudgeSummary {
	total: number;
	passed: number;
	failed: number;
	averageQualityScore: number;
}

export interface AggregatedJudgeOutcome {
	passedVotes: number;
	failedVotes: number;
	averageQualityScore: number;
	finalPassVerdict: "pass" | "fail";
	pass: boolean;
}

interface JudgePairAggregationInput {
	finalPassVerdict: "pass" | "fail";
	qualityScore: number;
}

export function resolveLlmJudgeRuntimeConfig(): LlmJudgeRuntimeConfig {
	return {
		judge: {
			provider:
				process.env.COMPOSER_EVAL_JUDGE_PROVIDER?.trim() || DEFAULT_JUDGE_PROVIDER,
			model:
				process.env.COMPOSER_EVAL_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL,
			label: "judge",
			temperature: parseOptionalNumber(
				process.env.COMPOSER_EVAL_JUDGE_TEMPERATURE,
			),
		},
		verifier: {
			provider:
				process.env.COMPOSER_EVAL_VERIFY_PROVIDER?.trim() ||
				process.env.COMPOSER_EVAL_JUDGE_PROVIDER?.trim() ||
				DEFAULT_VERIFY_PROVIDER,
			model:
				process.env.COMPOSER_EVAL_VERIFY_MODEL?.trim() || DEFAULT_VERIFY_MODEL,
			label: "verify",
			temperature:
				parseOptionalNumber(process.env.COMPOSER_EVAL_VERIFY_TEMPERATURE) ?? 0,
		},
		repeat: parseRepeat(process.env.COMPOSER_EVAL_JUDGE_REPEAT),
		minScore: parseMinScore(process.env.COMPOSER_EVAL_JUDGE_MIN_SCORE),
	};
}

export function formatLlmJudgeRuntimeConfig(
	config: LlmJudgeRuntimeConfig,
): string {
	return [
		`judge=${config.judge.provider}:${config.judge.model}`,
		`verify=${config.verifier.provider}:${config.verifier.model}`,
		`repeat=${config.repeat}`,
		`minScore=${config.minScore.toFixed(2)}`,
	].join(" ");
}

export async function runVerifiedJudgeCase(
	input: LlmJudgeCaseInput,
	config = resolveLlmJudgeRuntimeConfig(),
): Promise<VerifiedJudgeResult> {
	const pairs: VerifiedJudgePair[] = [];

	for (let index = 0; index < config.repeat; index += 1) {
		const label = config.repeat === 1 ? "judge" : `judge-${index + 1}`;
		const judge = await runStructuredJsonPrompt(
			{
				...config.judge,
				label,
			},
			{
				schemaName: buildSchemaName(input.suiteName, input.caseName, label),
				schema: LlmJudgeVerdictSchema,
				systemPrompt: PRIMARY_JUDGE_SYSTEM_PROMPT,
				userPrompt: buildPrimaryJudgePrompt(input),
			},
		);

		const verification = await runStructuredJsonPrompt(
			{
				...config.verifier,
				label: config.repeat === 1 ? "verify" : `verify-${index + 1}`,
			},
			{
				schemaName: buildSchemaName(
					input.suiteName,
					input.caseName,
					`verify_${index + 1}`,
				),
				schema: LlmJudgeVerificationSchema,
				systemPrompt: VERIFIER_SYSTEM_PROMPT,
				userPrompt: buildVerificationPrompt(input, judge),
			},
		);

		const finalPassVerdict = verification.verifiedPassVerdict;
		const effectiveQualityScore = verification.verifiedQualityScore;
		const qualityPass = effectiveQualityScore >= config.minScore;
		pairs.push({
			label,
			judgeModel: { ...config.judge, label },
			verifierModel: {
				...config.verifier,
				label: config.repeat === 1 ? "verify" : `verify-${index + 1}`,
			},
			judge,
			verification,
			effectiveQualityScore,
			qualityPass,
			finalPassVerdict,
			pass: finalPassVerdict === "pass" && qualityPass,
		});
	}

	const aggregated = aggregateJudgeOutcome(
		pairs.map((pair) => ({
			finalPassVerdict: pair.finalPassVerdict,
			qualityScore: pair.effectiveQualityScore,
		})),
		config.minScore,
		input.deterministicPass ?? true,
	);

	return {
		input,
		pairs,
		...aggregated,
	};
}

export function aggregateJudgeOutcome(
	pairs: JudgePairAggregationInput[],
	minScore: number,
	deterministicPass: boolean,
): AggregatedJudgeOutcome {
	const passedVotes = pairs.filter(
		(pair) => pair.finalPassVerdict === "pass",
	).length;
	const failedVotes = pairs.length - passedVotes;
	const finalPassVerdict =
		passedVotes >= Math.ceil(Math.max(pairs.length, 1) / 2) ? "pass" : "fail";
	const qualityPool = pairs.filter(
		(pair) => pair.finalPassVerdict === finalPassVerdict,
	);
	const averageQualityScore =
		qualityPool.length > 0
			? qualityPool.reduce((sum, pair) => sum + pair.qualityScore, 0) /
				qualityPool.length
			: 0;

	return {
		passedVotes,
		failedVotes,
		averageQualityScore,
		finalPassVerdict,
		pass:
			deterministicPass &&
			finalPassVerdict === "pass" &&
			averageQualityScore >= minScore,
	};
}

export function summarizeVerifiedJudgeResults(
	results: VerifiedJudgeResult[],
): VerifiedJudgeSummary {
	const total = results.length;
	const passed = results.filter((result) => result.pass).length;
	const failed = total - passed;
	const averageQualityScore =
		total > 0
			? results.reduce((sum, result) => sum + result.averageQualityScore, 0) /
				total
			: 0;

	return {
		total,
		passed,
		failed,
		averageQualityScore,
	};
}

export async function runStructuredJsonPrompt<T extends TSchema>(
	modelConfig: JudgeModelConfig,
	options: {
		schemaName: string;
		schema: T;
		systemPrompt: string;
		userPrompt: string;
	},
): Promise<Static<T>> {
	const runtime = await loadJudgeRuntimeModules();
	const model = await resolveOpenAiJudgeModel(runtime.getModel, modelConfig);
	const credential = runtime.lookupApiKey(model.provider);
	if (!credential.key) {
		const checkedText = credential.checkedEnvVars.join(", ") || "(no env vars configured)";
		throw new Error(
			`Missing API key for provider "${model.provider}". Checked: ${checkedText}`,
		);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: options.userPrompt,
		timestamp: Date.now(),
	};
	const context: Context = {
		systemPrompt: options.systemPrompt,
		messages: [userMessage],
		tools: [],
	};

	const text = await collectStructuredResponseText(
		runtime,
		runtime.streamOpenAI,
		model,
		context,
		credential.key,
		options.schemaName,
		options.schema,
		modelConfig.temperature,
	);
	const parsed = normalizeParsedJudgePayload(
		parseStructuredJson(text),
		options.schema,
	);

	if (!Value.Check(options.schema, parsed)) {
		throw new Error(
			`Structured judge response for ${options.schemaName} did not match the expected schema. Received ${inspect(parsed, {
				depth: 6,
				breakLength: 120,
				sorted: true,
			})}`,
		);
	}

	return parsed as Static<T>;
}

function buildPrimaryJudgePrompt(input: LlmJudgeCaseInput): string {
	return [
		`Suite: ${input.suiteName}`,
		`Case: ${input.caseName}`,
		input.scenarioSummary ? `Scenario:\n${input.scenarioSummary}` : null,
		`Rubric:\n${input.rubric}`,
		input.expectedSubset !== undefined
			? `Expected essential facts:\n${stableStringify(input.expectedSubset)}`
			: null,
		`Observed output:\n${stableStringify(input.observedOutput)}`,
		input.deterministicMismatch
			? `Deterministic mismatch note:\n${input.deterministicMismatch}`
			: null,
		'Output requirements: return only JSON with reasoningText, passVerdict, qualityScore, issueList, and strengthList.',
		"Return reasoning grounded in the observed output before deciding pass or fail.",
	].filter(Boolean).join("\n\n");
}

function buildVerificationPrompt(
	input: LlmJudgeCaseInput,
	judge: LlmJudgeVerdict,
): string {
	return [
		`Suite: ${input.suiteName}`,
		`Case: ${input.caseName}`,
		input.scenarioSummary ? `Scenario:\n${input.scenarioSummary}` : null,
		`Rubric:\n${input.rubric}`,
		input.expectedSubset !== undefined
			? `Expected essential facts:\n${stableStringify(input.expectedSubset)}`
			: null,
		`Observed output:\n${stableStringify(input.observedOutput)}`,
		`Initial judge verdict:\n${stableStringify(judge)}`,
		'Output requirements: return only JSON with reasoningText, verdictAgreement, verifiedPassVerdict, verifiedQualityScore, and criticalIssueList.',
		"Verify whether the initial verdict is grounded in the rubric and the observed output.",
		"Return the corrected pass/fail verdict if needed and a verifiedQualityScore between 0 and 1 for your final judgment.",
	].filter(Boolean).join("\n\n");
}

async function collectStructuredResponseText(
	runtime: JudgeRuntimeModules,
	streamOpenAi: StreamOpenAIFn,
	model: Model<"openai-completions" | "openai-responses">,
	context: Context,
	apiKey: string,
	schemaName: string,
	schema: TSchema,
	temperature?: number,
): Promise<string> {
	if (shouldUsePromptOnlyJson(model)) {
		return await collectPromptOnlyResponseText(runtime, model, apiKey, context, temperature);
	}

	let text = "";
	let finalMessage: AssistantMessage | undefined;

	for await (const event of streamOpenAi(model, context, {
		apiKey,
		temperature,
		responseFormat: {
			type: "json_schema",
			json_schema: {
				name: schemaName,
				schema,
				strict: true,
			},
		},
	})) {
		if (event.type === "text_delta") {
			text += event.delta;
		}
		if (event.type === "done") {
			finalMessage = event.message;
		}
		if (event.type === "error") {
			throw new Error(
				`Judge provider error: ${inspect(event.error, {
					depth: 6,
					breakLength: 120,
					sorted: true,
				})}`,
			);
		}
	}

	if (text.trim()) {
		return text.trim();
	}

	if (finalMessage) {
		return extractAssistantText(finalMessage).trim();
	}

	throw new Error(`No structured judge response text was produced for ${schemaName}.`);
}

async function collectPromptOnlyResponseText(
	runtime: JudgeRuntimeModules,
	model: Model<"openai-completions" | "openai-responses">,
	apiKey: string,
	context: Context,
	temperature?: number,
): Promise<string> {
	const transport = new runtime.ProviderTransport({
		getApiKey(provider) {
			return provider === model.provider ? apiKey : undefined;
		},
	});
	const agent = new runtime.Agent({
		transport,
		initialState: {
			model,
			systemPrompt: context.systemPrompt,
			tools: [],
			...(temperature !== undefined ? { temperature } : {}),
		},
	});

	const userPrompt = context.messages
		.filter((message): message is UserMessage => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
					.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
		)
		.join("\n\n");

	await agent.prompt(userPrompt);
	const assistantMessage = [...agent.state.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	if (!assistantMessage) {
		throw new Error("No assistant judge response was recorded.");
	}

	const text = extractAssistantText(assistantMessage).trim();
	if (!text) {
		throw new Error("The prompt-only judge did not return any text.");
	}
	return text;
}

async function resolveOpenAiJudgeModel(
	getModel: GetModelFn,
	config: JudgeModelConfig,
): Promise<Model<"openai-completions" | "openai-responses">> {
	const model = getModel(config.provider, config.model);
	if (!model) {
		throw new Error(
			`Judge model not found for ${config.provider}:${config.model}. Add it to the built-in model registry or choose a supported model.`,
		);
	}

	if (model.api !== "openai-completions" && model.api !== "openai-responses") {
		throw new Error(
			`Judge model ${config.provider}:${config.model} uses unsupported API ${model.api}. Choose an OpenAI-compatible model for structured judging.`,
		);
	}

	return model as Model<"openai-completions" | "openai-responses">;
}

async function loadJudgeRuntimeModules(): Promise<JudgeRuntimeModules> {
	if (!judgeRuntimePromise) {
		judgeRuntimePromise = Promise.all([
			import(pathToFileURL(join(projectRoot, "dist/agent/providers/openai.js")).href),
			import(pathToFileURL(join(projectRoot, "dist/agent/agent.js")).href),
			import(pathToFileURL(join(projectRoot, "dist/agent/transport.js")).href),
			import(pathToFileURL(join(projectRoot, "dist/models/builtin.js")).href),
			import(pathToFileURL(join(projectRoot, "dist/providers/api-keys.js")).href),
		]).then(([openAi, agent, transport, builtin, apiKeys]) => ({
			streamOpenAI: openAi.streamOpenAI as StreamOpenAIFn,
			Agent: agent.Agent as AgentCtor,
			ProviderTransport: transport.ProviderTransport as ProviderTransportCtor,
			getModel: builtin.getModel as GetModelFn,
			lookupApiKey: apiKeys.lookupApiKey as LookupApiKeyFn,
		}));
	}

	return await judgeRuntimePromise;
}

function shouldUsePromptOnlyJson(
	model: Model<"openai-completions" | "openai-responses">,
): boolean {
	const modelId = model.id.toLowerCase();
	return model.provider === "anthropic" || modelId.includes("claude");
}

export function parseStructuredJson(text: string): unknown {
	const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
	try {
		return JSON.parse(cleaned);
	} catch (error) {
		const extracted = extractJsonObject(cleaned);
		if (extracted) {
			try {
				return JSON.parse(extracted);
			} catch {
				// Fall through to the original parse error below.
			}
		}
		throw new Error(
			`Failed to parse structured judge response as JSON: ${error instanceof Error ? error.message : String(error)}\nResponse:\n${cleaned}`,
		);
	}
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => {
			return block.type === "text";
		})
		.map((block) => block.text)
		.join("\n");
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value), null, 2) ?? String(value);
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeysDeep(entry));
	}

	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return Object.fromEntries(
			entries.map(([key, entryValue]) => [key, sortKeysDeep(entryValue)]),
		);
	}

	return value;
}

function sanitizeIdentifier(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "judge";
}

function buildSchemaName(
	suiteName: string,
	caseName: string,
	suffix: string,
): string {
	const raw = [suiteName, caseName, suffix].join("_");
	const sanitized = sanitizeIdentifier(raw);
	const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
	return `${sanitized.slice(0, 55)}_${hash}`;
}

function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		return null;
	}
	return text.slice(start, end + 1);
}

export function normalizeParsedJudgePayload(
	value: unknown,
	schema: TSchema,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const record = { ...(value as Record<string, unknown>) };
	assignAlias(record, "reasoningText", ["reasoning", "explanation"]);

	if (schema === LlmJudgeVerdictSchema) {
		assignAlias(record, "passVerdict", ["verdict"]);
		assignAlias(record, "qualityScore", ["score"]);
		assignAlias(record, "issueList", ["issues"]);
		assignAlias(record, "strengthList", ["strengths"]);
		ensureStringArray(record, "issueList");
		ensureStringArray(record, "strengthList");
		coerceNumber(record, "qualityScore");
		return {
			reasoningText: record.reasoningText,
			passVerdict: record.passVerdict,
			qualityScore: record.qualityScore,
			issueList: record.issueList,
			strengthList: record.strengthList,
		};
	} else if (schema === LlmJudgeVerificationSchema) {
		assignAlias(record, "verdictAgreement", ["verdictAgrement", "agreement"]);
		assignAlias(record, "verifiedPassVerdict", ["verdict", "passVerdict"]);
		assignAlias(record, "verifiedQualityScore", ["qualityScore", "score"]);
		assignAlias(record, "criticalIssueList", ["criticalIssues", "issues"]);
		ensureStringArray(record, "criticalIssueList");
		coerceNumber(record, "verifiedQualityScore");
		return {
			reasoningText: record.reasoningText,
			verdictAgreement: record.verdictAgreement,
			verifiedPassVerdict: record.verifiedPassVerdict,
			verifiedQualityScore: record.verifiedQualityScore,
			criticalIssueList: record.criticalIssueList,
		};
	}
	return record;
}

function assignAlias(
	record: Record<string, unknown>,
	key: string,
	aliases: string[],
): void {
	if (record[key] !== undefined) {
		return;
	}

	for (const alias of aliases) {
		if (record[alias] !== undefined) {
			record[key] = record[alias];
			return;
		}
	}
}

function ensureStringArray(record: Record<string, unknown>, key: string): void {
	const value = record[key];
	if (value === undefined) {
		record[key] = [];
		return;
	}
	if (Array.isArray(value)) {
		record[key] = value.map((entry) => String(entry));
		return;
	}
	record[key] = [String(value)];
}

function coerceNumber(record: Record<string, unknown>, key: string): void {
	const value = record[key];
	if (typeof value === "number") {
		return;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			record[key] = parsed;
		}
	}
}

function parseOptionalNumber(value: string | undefined): number | undefined {
	if (!value?.trim()) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Expected a numeric value but received ${JSON.stringify(value)}.`);
	}
	return parsed;
}

function parseMinScore(value: string | undefined): number {
	if (!value?.trim()) {
		return DEFAULT_MIN_SCORE;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(
			`COMPOSER_EVAL_JUDGE_MIN_SCORE must be a number between 0 and 1. Received ${JSON.stringify(value)}.`,
		);
	}
	return parsed;
}

function parseRepeat(value: string | undefined): number {
	if (!value?.trim()) {
		return DEFAULT_REPEAT;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
		throw new Error(
			`COMPOSER_EVAL_JUDGE_REPEAT must be an integer between 1 and 5. Received ${JSON.stringify(value)}.`,
		);
	}
	return parsed;
}
