import {
	type DownstreamFailureMode,
	fetchDownstream,
} from "../utils/downstream-http.js";
import {
	getEnvValue,
	normalizeBaseUrl,
	parsePositiveInt,
	resolveConfiguredToken,
	resolveWorkspaceId,
	trimString,
} from "./client.js";

type JsonRecord = Record<string, unknown>;

interface CerebroSearchResponse {
	things?: JsonRecord[];
	evidence?: JsonRecord[];
}

interface CerebroGetThingResponse {
	thing?: JsonRecord;
	facts?: JsonRecord[];
	recentEvents?: JsonRecord[];
	evidence?: JsonRecord[];
}

interface CerebroListChangesResponse {
	changes?: JsonRecord[];
}

export interface MaestroFactsContext {
	provider: "cerebro";
	workspaceId: string;
	query: string;
	thingIds: string[];
	factIds: string[];
	things: JsonRecord[];
	facts: JsonRecord[];
	events: JsonRecord[];
	changes: JsonRecord[];
	evidence: JsonRecord[];
	summary: {
		thingCount: number;
		factCount: number;
		eventCount: number;
		changeCount: number;
		evidenceCount: number;
	};
}

export interface MaestroSessionFactsInput {
	workspaceId?: string;
	sessionId?: string;
	actorId?: string;
	factsQuery?: string;
	metadata?: Record<string, unknown>;
}

export interface CerebroFactsServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId?: string;
	timeoutMs: number;
	maxAttempts: number;
	searchLimit: number;
	changeLimit: number;
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_CHANGE_LIMIT = 10;
const MAX_PROMPT_CHARS = 4_000;

const CEREBRO_BASE_URL_ENV_VARS = [
	"MAESTRO_CEREBRO_URL",
	"CEREBRO_URL",
	"CEREBRO_SERVICE_URL",
] as const;

const CEREBRO_TOKEN_ENV_VARS = [
	"MAESTRO_CEREBRO_TOKEN",
	"CEREBRO_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const CEREBRO_WORKSPACE_ENV_VARS = [
	"MAESTRO_CEREBRO_WORKSPACE_ID",
	"CEREBRO_WORKSPACE_ID",
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
] as const;

const CEREBRO_TIMEOUT_ENV_VARS = [
	"MAESTRO_CEREBRO_TIMEOUT_MS",
	"CEREBRO_TIMEOUT_MS",
] as const;

const CEREBRO_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_CEREBRO_MAX_ATTEMPTS",
	"CEREBRO_MAX_ATTEMPTS",
] as const;

const CEREBRO_SEARCH_LIMIT_ENV_VARS = [
	"MAESTRO_CEREBRO_SEARCH_LIMIT",
	"CEREBRO_SEARCH_LIMIT",
] as const;

const CEREBRO_CHANGE_LIMIT_ENV_VARS = [
	"MAESTRO_CEREBRO_CHANGE_LIMIT",
	"CEREBRO_CHANGE_LIMIT",
] as const;

const CEREBRO_SERVICE_PATH = "/cerebro.v1.CerebroService/";

function jsonRecordArray(value: unknown): JsonRecord[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is JsonRecord =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

function recordId(record: JsonRecord): string | undefined {
	const id = record.id;
	return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function pushUniqueRecord(
	records: JsonRecord[],
	seen: Set<string>,
	record: JsonRecord | undefined,
): void {
	if (!record) {
		return;
	}
	const id = recordId(record);
	if (id && seen.has(id)) {
		return;
	}
	if (id) {
		seen.add(id);
	}
	records.push(record);
}

function pickMetadataString(
	metadata: Record<string, unknown> | undefined,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = metadata?.[name];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function compactJson(value: unknown): string {
	return JSON.stringify(value);
}

function appendRecords(
	sections: string[],
	label: string,
	records: readonly JsonRecord[],
): void {
	if (records.length === 0) {
		return;
	}
	sections.push(
		`${label}:\n${records.map((record) => `- ${compactJson(record)}`).join("\n")}`,
	);
}

function truncatePromptAddition(value: string): string {
	if (value.length <= MAX_PROMPT_CHARS) {
		return value;
	}
	return `${value.slice(0, MAX_PROMPT_CHARS).trimEnd()}\n[truncated]`;
}

export function buildMaestroSessionFactsQuery(
	input: MaestroSessionFactsInput,
): string | undefined {
	return (
		trimString(input.factsQuery) ??
		pickMetadataString(
			input.metadata,
			"prompt",
			"objective",
			"task",
			"title",
			"workspace_root",
		)
	);
}

export function resolveCerebroFactsServiceConfig(): CerebroFactsServiceConfig | null {
	const baseUrl = getEnvValue(CEREBRO_BASE_URL_ENV_VARS);
	if (!baseUrl) {
		return null;
	}
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		token: resolveConfiguredToken(CEREBRO_TOKEN_ENV_VARS),
		workspaceId: resolveWorkspaceId(CEREBRO_WORKSPACE_ENV_VARS),
		timeoutMs: parsePositiveInt(
			getEnvValue(CEREBRO_TIMEOUT_ENV_VARS),
			DEFAULT_TIMEOUT_MS,
		),
		maxAttempts: parsePositiveInt(
			getEnvValue(CEREBRO_MAX_ATTEMPTS_ENV_VARS),
			DEFAULT_MAX_ATTEMPTS,
		),
		searchLimit: parsePositiveInt(
			getEnvValue(CEREBRO_SEARCH_LIMIT_ENV_VARS),
			DEFAULT_SEARCH_LIMIT,
		),
		changeLimit: parsePositiveInt(
			getEnvValue(CEREBRO_CHANGE_LIMIT_ENV_VARS),
			DEFAULT_CHANGE_LIMIT,
		),
	};
}

export async function gatherMaestroSessionFactsContext(
	input: MaestroSessionFactsInput,
	options?: {
		config?: CerebroFactsServiceConfig | null;
		signal?: AbortSignal;
		failureMode?: DownstreamFailureMode;
	},
): Promise<MaestroFactsContext | undefined> {
	const config = options?.config ?? resolveCerebroFactsServiceConfig();
	const workspaceId = trimString(input.workspaceId) ?? config?.workspaceId;
	const query = buildMaestroSessionFactsQuery(input);
	if (!config || !workspaceId || !query) {
		return undefined;
	}

	const things: JsonRecord[] = [];
	const facts: JsonRecord[] = [];
	const events: JsonRecord[] = [];
	const changes: JsonRecord[] = [];
	const evidence: JsonRecord[] = [];
	const thingIds = new Set<string>();
	const factIds = new Set<string>();
	const eventIds = new Set<string>();
	const changeIds = new Set<string>();
	const evidenceIds = new Set<string>();

	const search = await postCerebro<CerebroSearchResponse>(
		config,
		"Search",
		{
			workspaceId,
			query,
			limit: config.searchLimit,
			includeMap: true,
		},
		{ signal: options?.signal, failureMode: options?.failureMode },
	);
	for (const thing of jsonRecordArray(search.things)) {
		pushUniqueRecord(things, thingIds, thing);
	}
	for (const item of jsonRecordArray(search.evidence)) {
		pushUniqueRecord(evidence, evidenceIds, item);
	}

	const thingResponses = await Promise.all(
		[...thingIds].map((thingId) =>
			postCerebro<CerebroGetThingResponse>(
				config,
				"GetThing",
				{ workspaceId, thingId },
				{ signal: options?.signal, failureMode: options?.failureMode },
			),
		),
	);
	for (const response of thingResponses) {
		pushUniqueRecord(things, thingIds, response.thing);
		for (const fact of jsonRecordArray(response.facts)) {
			pushUniqueRecord(facts, factIds, fact);
		}
		for (const event of jsonRecordArray(response.recentEvents)) {
			pushUniqueRecord(events, eventIds, event);
		}
		for (const item of jsonRecordArray(response.evidence)) {
			pushUniqueRecord(evidence, evidenceIds, item);
		}
	}

	if (thingIds.size > 0) {
		const response = await postCerebro<CerebroListChangesResponse>(
			config,
			"ListChanges",
			{ workspaceId, thingIds: [...thingIds], limit: config.changeLimit },
			{ signal: options?.signal, failureMode: options?.failureMode },
		);
		for (const change of jsonRecordArray(response.changes)) {
			pushUniqueRecord(changes, changeIds, change);
		}
	}

	return {
		provider: "cerebro",
		workspaceId,
		query,
		thingIds: [...thingIds],
		factIds: [...factIds],
		things,
		facts,
		events,
		changes,
		evidence,
		summary: {
			thingCount: things.length,
			factCount: facts.length,
			eventCount: events.length,
			changeCount: changes.length,
			evidenceCount: evidence.length,
		},
	};
}

export function formatMaestroFactsPromptAddition(
	context: MaestroFactsContext,
): string {
	const sections = [
		"# Cerebro Facts Context",
		[
			`Provider: ${context.provider}`,
			`Workspace: ${context.workspaceId}`,
			`Query: ${context.query}`,
			`Summary: ${compactJson(context.summary)}`,
		].join("\n"),
	];
	appendRecords(sections, "Things", context.things);
	appendRecords(sections, "Facts", context.facts);
	appendRecords(sections, "Recent events", context.events);
	appendRecords(sections, "Recent changes", context.changes);
	appendRecords(sections, "Evidence", context.evidence);
	return truncatePromptAddition(sections.join("\n\n"));
}

export async function buildMaestroFactsPromptAddition(
	input: MaestroSessionFactsInput,
	options?: {
		config?: CerebroFactsServiceConfig | null;
		signal?: AbortSignal;
		failureMode?: DownstreamFailureMode;
	},
): Promise<string | null> {
	const context = await gatherMaestroSessionFactsContext(input, options);
	return context ? formatMaestroFactsPromptAddition(context) : null;
}

async function postCerebro<ResponseBody>(
	config: CerebroFactsServiceConfig,
	method: string,
	body: JsonRecord,
	options?: {
		signal?: AbortSignal;
		failureMode?: DownstreamFailureMode;
	},
): Promise<ResponseBody> {
	const response = await fetchDownstream(
		`${config.baseUrl}${CEREBRO_SERVICE_PATH}${method}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
			},
			body: JSON.stringify(body),
			signal: options?.signal,
		},
		{
			serviceName: "cerebro facts service",
			failureMode: options?.failureMode ?? "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			fetchImpl: config.fetchImpl,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`cerebro facts service returned ${response.status}: ${
				text || response.statusText
			}`,
		);
	}
	return (await response.json()) as ResponseBody;
}
