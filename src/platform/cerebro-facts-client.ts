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
	links?: JsonRecord[];
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

interface CerebroMapThingResponse {
	root?: JsonRecord;
	things?: JsonRecord[];
	links?: JsonRecord[];
	paths?: JsonRecord[];
	evidence?: JsonRecord[];
}

export interface MaestroFactsContextSummary {
	thingCount: number;
	linkCount: number;
	pathCount: number;
	factCount: number;
	eventCount: number;
	changeCount: number;
	evidenceCount: number;
	watermarkCount: number;
}

export interface MaestroFactsContext {
	provider: "cerebro";
	workspaceId: string;
	query: string;
	thingIds: string[];
	linkIds: string[];
	factIds: string[];
	eventIds: string[];
	things: JsonRecord[];
	links: JsonRecord[];
	paths: JsonRecord[];
	facts: JsonRecord[];
	events: JsonRecord[];
	changes: JsonRecord[];
	evidence: JsonRecord[];
	watermarks: JsonRecord[];
	summary: MaestroFactsContextSummary;
}

export interface MaestroSessionFactsInput {
	workspaceId?: string;
	sessionId: string;
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
const CEREBRO_SERVICE_SUFFIX = "/cerebro.v1.CerebroService";

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

function recordStringArray(record: JsonRecord, name: string): string[] {
	const value = record[name];
	return Array.isArray(value)
		? value
				.filter(
					(item): item is string =>
						typeof item === "string" && item.trim().length > 0,
				)
				.map((item) => item.trim())
		: [];
}

function pathKey(path: JsonRecord): string | undefined {
	const id = recordId(path);
	if (id) {
		return `id:${id}`;
	}
	const thingIds = recordStringArray(path, "thingIds");
	const linkIds = recordStringArray(path, "linkIds");
	if (thingIds.length === 0 && linkIds.length === 0) {
		return undefined;
	}
	return `${thingIds.join("\u0000")}\u0001${linkIds.join("\u0000")}`;
}

function pushUniquePath(
	paths: JsonRecord[],
	seen: Set<string>,
	path: JsonRecord | undefined,
): void {
	if (!path) {
		return;
	}
	const key = pathKey(path);
	if (!key || seen.has(key)) {
		return;
	}
	seen.add(key);
	paths.push(path);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
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

function normalizeCerebroBaseUrl(baseUrl: string): string {
	return normalizeBaseUrl(baseUrl, [CEREBRO_SERVICE_SUFFIX]);
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
		baseUrl: normalizeCerebroBaseUrl(baseUrl),
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
	const links: JsonRecord[] = [];
	const paths: JsonRecord[] = [];
	const facts: JsonRecord[] = [];
	const events: JsonRecord[] = [];
	const changes: JsonRecord[] = [];
	const evidence: JsonRecord[] = [];
	const watermarks: JsonRecord[] = [];
	const thingIds = new Set<string>();
	const linkIds = new Set<string>();
	const pathIds = new Set<string>();
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
	for (const link of jsonRecordArray(search.links)) {
		pushUniqueRecord(links, linkIds, link);
	}
	for (const item of jsonRecordArray(search.evidence)) {
		pushUniqueRecord(evidence, evidenceIds, item);
	}

	const mapThingIds = [...thingIds];
	const thingResponses = await Promise.all(
		mapThingIds.map((thingId) =>
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

	const changeThingIds = [...thingIds];
	if (mapThingIds.length > 0) {
		const mapResults = await Promise.allSettled(
			mapThingIds.map((thingId) =>
				postCerebro<CerebroMapThingResponse>(
					config,
					"MapThing",
					{ workspaceId, thingId, depth: 1 },
					{ signal: options?.signal, failureMode: options?.failureMode },
				),
			),
		);
		for (const result of mapResults) {
			if (result.status === "rejected") {
				if (isAbortError(result.reason)) {
					throw result.reason;
				}
				continue;
			}
			const response = result.value;
			pushUniqueRecord(things, thingIds, response.root);
			for (const thing of jsonRecordArray(response.things)) {
				pushUniqueRecord(things, thingIds, thing);
			}
			for (const link of jsonRecordArray(response.links)) {
				pushUniqueRecord(links, linkIds, link);
			}
			for (const path of jsonRecordArray(response.paths)) {
				pushUniquePath(paths, pathIds, path);
			}
			for (const item of jsonRecordArray(response.evidence)) {
				pushUniqueRecord(evidence, evidenceIds, item);
			}
		}
	}

	if (changeThingIds.length > 0) {
		const response = await postCerebro<CerebroListChangesResponse>(
			config,
			"ListChanges",
			{ workspaceId, thingIds: changeThingIds, limit: config.changeLimit },
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
		linkIds: [...linkIds],
		factIds: [...factIds],
		eventIds: [...eventIds],
		things,
		links,
		paths,
		facts,
		events,
		changes,
		evidence,
		watermarks,
		summary: {
			thingCount: things.length,
			linkCount: links.length,
			pathCount: paths.length,
			factCount: facts.length,
			eventCount: events.length,
			changeCount: changes.length,
			evidenceCount: evidence.length,
			watermarkCount: watermarks.length,
		},
	};
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
		throw new Error(
			`cerebro facts service returned ${response.status}: ${
				(await response.text()) || response.statusText
			}`,
		);
	}
	return (await response.json()) as ResponseBody;
}
