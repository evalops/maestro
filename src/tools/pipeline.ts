import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { fetchDownstream } from "../utils/downstream-http.js";
import { createTool } from "./tool-dsl.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;

interface PipelineConfig {
	apiUrl: string;
	token: string;
	timeoutMs: number;
	maxAttempts: number;
}

interface PipelineContact {
	id: string;
	first_name?: string;
	last_name?: string;
	email?: string;
	title?: string;
	company_id?: string;
	stage?: string;
	seniority?: string;
	linkedin_url?: string;
	tags?: string[];
}

interface PipelineDeal {
	id: string;
	title?: string;
	stage?: string;
	value?: number;
	currency?: string;
	probability?: number;
	expected_close?: string;
	contact_id?: string;
	company_id?: string;
}

export interface PipelineActivity {
	id: string;
	owner_type?: string;
	owner_id?: string;
	activity_type?: string;
	channel?: string;
	direction?: string;
	subject?: string;
	body?: string;
	outcome?: string;
	occurred_at?: string;
}

export interface PipelineSignal {
	id?: string;
	owner_type?: string;
	owner_id?: string;
	signal_type?: string;
	source?: string;
	strength?: number;
	data?: unknown;
}

interface PipelineListResponse<T> {
	items: T[];
}

function getPipelineConfig(): PipelineConfig | null {
	const apiUrl = process.env.PIPELINE_API_URL?.trim();
	const token = process.env.PIPELINE_SERVICE_TOKEN?.trim();
	if (!apiUrl || !token) {
		return null;
	}
	return {
		apiUrl: apiUrl.replace(/\/+$/, ""),
		maxAttempts: parsePositiveInt(
			process.env.PIPELINE_API_MAX_ATTEMPTS,
			DEFAULT_MAX_ATTEMPTS,
		),
		timeoutMs: parsePositiveInt(
			process.env.PIPELINE_API_TIMEOUT_MS,
			DEFAULT_REQUEST_TIMEOUT_MS,
		),
		token,
	};
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createMissingConfigError(): Error {
	return new Error(
		"Pipeline CRM is not configured. Set PIPELINE_API_URL and PIPELINE_SERVICE_TOKEN.",
	);
}

async function pipelineFetch<T>(
	config: PipelineConfig,
	method: string,
	path: string,
	options: {
		signal?: AbortSignal;
		body?: unknown;
		headers?: Record<string, string>;
	} = {},
): Promise<T> {
	const response = await fetchDownstream(
		`${config.apiUrl}${path}`,
		{
			method,
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
				...options.headers,
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		},
		{
			serviceName: "Pipeline API",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Pipeline API ${method} ${path} returned ${response.status}: ${body || "Unknown error"}`,
		);
	}

	return (await response.json()) as T;
}

function idempotencyHeaders(): Record<string, string> {
	return { "Idempotency-Key": randomUUID() };
}

function mergeSignalData(summary?: string, data?: unknown): unknown {
	if (!summary) {
		return data;
	}
	if (data === undefined) {
		return { summary };
	}
	if (data !== null && typeof data === "object" && !Array.isArray(data)) {
		return { summary, ...(data as Record<string, unknown>) };
	}
	return { summary, value: data };
}

function formatContactName(contact: PipelineContact): string {
	const parts = [contact.first_name, contact.last_name]
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value));
	if (parts.length > 0) {
		return parts.join(" ");
	}
	return contact.email?.trim() || contact.id;
}

function formatQuerySummary(
	label: string,
	parts: Array<string | undefined>,
): string | null {
	const first = parts
		.map((value) => value?.trim())
		.find((value): value is string => Boolean(value));
	return first ? `${label} "${first}"` : label;
}

const pipelineSearchContactsSchema = Type.Object({
	query: Type.Optional(
		Type.String({ description: "Free-text contact query (maps to name)" }),
	),
	name: Type.Optional(
		Type.String({ description: "Name to search for (partial match)" }),
	),
	email: Type.Optional(
		Type.String({ description: "Email to search for (partial match)" }),
	),
	stage: Type.Optional(Type.String({ description: "Pipeline stage filter" })),
	companyId: Type.Optional(
		Type.String({ description: "Filter by company UUID" }),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum results to return",
			minimum: 1,
			maximum: 100,
			default: 10,
		}),
	),
});

const pipelineSearchDealsSchema = Type.Object({
	stage: Type.Optional(Type.String({ description: "Deal stage filter" })),
	contactId: Type.Optional(
		Type.String({ description: "Filter by contact UUID" }),
	),
	companyId: Type.Optional(
		Type.String({ description: "Filter by company UUID" }),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "Maximum results to return",
			minimum: 1,
			maximum: 100,
			default: 10,
		}),
	),
});

const pipelineCreateSignalSchema = Type.Object({
	ownerType: Type.String({
		description: "Signal owner type, typically contact or company",
	}),
	ownerId: Type.String({ description: "Signal owner UUID" }),
	signalType: Type.String({ description: "Signal type" }),
	source: Type.String({ description: "Signal source" }),
	strength: Type.Optional(
		Type.Integer({
			description: "Signal strength from 0-100",
			minimum: 0,
			maximum: 100,
		}),
	),
	summary: Type.Optional(
		Type.String({ description: "Human-readable signal summary" }),
	),
	data: Type.Optional(Type.Any({ description: "Arbitrary signal payload" })),
});

const pipelineLogActivitySchema = Type.Object({
	ownerType: Type.String({
		description: "Activity owner type, such as contact, company, or deal",
	}),
	ownerId: Type.String({ description: "Activity owner UUID" }),
	activityType: Type.String({ description: "Activity type identifier" }),
	channel: Type.String({ description: "Activity channel" }),
	direction: Type.Optional(
		Type.String({ description: "Direction, defaults to outbound" }),
	),
	subject: Type.Optional(
		Type.String({ description: "Activity subject or topic" }),
	),
	body: Type.Optional(Type.String({ description: "Activity body or notes" })),
	outcome: Type.Optional(
		Type.String({ description: "Optional activity outcome" }),
	),
	occurredAt: Type.Optional(
		Type.String({ description: "Occurred-at timestamp (ISO-8601)" }),
	),
});

export interface PipelineSearchContactsDetails {
	contacts: Array<{
		id: string;
		name: string;
		email?: string;
		title?: string;
		companyId?: string;
		stage?: string;
		seniority?: string;
		linkedinUrl?: string;
		tags?: string[];
	}>;
	count: number;
}

export interface PipelineSearchDealsDetails {
	deals: Array<{
		id: string;
		title: string;
		stage?: string;
		value?: number;
		currency?: string;
		probability?: number;
		expectedClose?: string;
		contactId?: string;
		companyId?: string;
	}>;
	count: number;
}

export const pipelineSearchContactsTool = createTool<
	typeof pipelineSearchContactsSchema,
	PipelineSearchContactsDetails
>({
	name: "pipeline_search_contacts",
	label: "pipeline contacts",
	description:
		"Search Pipeline CRM contacts using the internal evalops Pipeline service.",
	schema: pipelineSearchContactsSchema,
	getDisplayName: () => "Pipeline Contacts",
	getToolUseSummary(params) {
		return formatQuerySummary("Search Pipeline contacts for", [
			params.name,
			params.query,
			params.email,
			params.stage,
		]);
	},
	getActivityDescription: () => "Searching Pipeline contacts",
	async run(params, { respond, signal }) {
		const config = getPipelineConfig();
		if (!config) {
			throw createMissingConfigError();
		}

		const query = new URLSearchParams();
		const name = params.name ?? params.query;
		if (name) query.set("name", name);
		if (params.email) query.set("email", params.email);
		if (params.stage) query.set("stage", params.stage);
		if (params.companyId) query.set("company_id", params.companyId);
		query.set("limit", String(params.limit ?? 10));

		const result = await pipelineFetch<PipelineListResponse<PipelineContact>>(
			config,
			"GET",
			`/api/v1/contacts?${query.toString()}`,
			{ signal },
		);

		const contacts = result.items.map((contact) => ({
			id: contact.id,
			name: formatContactName(contact),
			email: contact.email,
			title: contact.title,
			companyId: contact.company_id,
			stage: contact.stage,
			seniority: contact.seniority,
			linkedinUrl: contact.linkedin_url,
			tags: contact.tags,
		}));

		respond.text(
			`Found ${contacts.length} Pipeline contact${contacts.length === 1 ? "" : "s"}.`,
		);
		for (const contact of contacts.slice(0, 10)) {
			const segments = [
				contact.name,
				contact.email,
				contact.title,
				contact.stage,
			].filter((value): value is string => Boolean(value));
			respond.text(`- ${segments.join(" • ")}`);
		}
		respond.detail({ contacts, count: contacts.length });
		return respond;
	},
});

export const pipelineSearchDealsTool = createTool<
	typeof pipelineSearchDealsSchema,
	PipelineSearchDealsDetails
>({
	name: "pipeline_search_deals",
	label: "pipeline deals",
	description:
		"Search Pipeline CRM deals using the internal evalops Pipeline service.",
	schema: pipelineSearchDealsSchema,
	getDisplayName: () => "Pipeline Deals",
	getToolUseSummary(params) {
		return formatQuerySummary("Search Pipeline deals for", [
			params.companyId,
			params.contactId,
			params.stage,
		]);
	},
	getActivityDescription: () => "Searching Pipeline deals",
	async run(params, { respond, signal }) {
		const config = getPipelineConfig();
		if (!config) {
			throw createMissingConfigError();
		}

		const query = new URLSearchParams();
		if (params.stage) query.set("stage", params.stage);
		if (params.contactId) query.set("contact_id", params.contactId);
		if (params.companyId) query.set("company_id", params.companyId);
		query.set("limit", String(params.limit ?? 10));

		const result = await pipelineFetch<PipelineListResponse<PipelineDeal>>(
			config,
			"GET",
			`/api/v1/deals?${query.toString()}`,
			{ signal },
		);

		const deals = result.items.map((deal) => ({
			id: deal.id,
			title: deal.title?.trim() || deal.id,
			stage: deal.stage,
			value: deal.value,
			currency: deal.currency,
			probability: deal.probability,
			expectedClose: deal.expected_close,
			contactId: deal.contact_id,
			companyId: deal.company_id,
		}));

		respond.text(
			`Found ${deals.length} Pipeline deal${deals.length === 1 ? "" : "s"}.`,
		);
		for (const deal of deals.slice(0, 10)) {
			const segments = [
				deal.title,
				deal.stage,
				deal.value !== undefined
					? `${deal.currency ?? "USD"} ${deal.value}`
					: undefined,
				deal.expectedClose,
			].filter((value): value is string => Boolean(value));
			respond.text(`- ${segments.join(" • ")}`);
		}
		respond.detail({ deals, count: deals.length });
		return respond;
	},
});

export const pipelineCreateSignalTool = createTool<
	typeof pipelineCreateSignalSchema,
	PipelineSignal
>({
	name: "pipeline_create_signal",
	label: "pipeline signal",
	description:
		"Create a signal in Pipeline CRM using the internal evalops Pipeline service.",
	schema: pipelineCreateSignalSchema,
	getDisplayName: () => "Pipeline Signal",
	getToolUseSummary(params) {
		return formatQuerySummary("Create Pipeline signal", [
			params.summary,
			params.signalType,
		]);
	},
	getActivityDescription: () => "Creating Pipeline signal",
	async run(params, { respond, signal }) {
		const config = getPipelineConfig();
		if (!config) {
			throw createMissingConfigError();
		}

		const payload = {
			owner_type: params.ownerType,
			owner_id: params.ownerId,
			signal_type: params.signalType,
			source: params.source,
			...(params.strength !== undefined ? { strength: params.strength } : {}),
			...(params.summary !== undefined || params.data !== undefined
				? { data: mergeSignalData(params.summary, params.data) }
				: {}),
		};

		const result = await pipelineFetch<PipelineSignal>(
			config,
			"POST",
			"/api/v1/signals",
			{
				signal,
				body: payload,
				headers: idempotencyHeaders(),
			},
		);

		respond.text(
			`Created Pipeline signal${result.id ? ` ${result.id}` : ""} for ${params.ownerType} ${params.ownerId}.`,
		);
		respond.detail(result);
		return respond;
	},
});

export const pipelineLogActivityTool = createTool<
	typeof pipelineLogActivitySchema,
	PipelineActivity
>({
	name: "pipeline_log_activity",
	label: "pipeline activity",
	description:
		"Log an activity in Pipeline CRM using the internal evalops Pipeline service.",
	schema: pipelineLogActivitySchema,
	getDisplayName: () => "Pipeline Activity",
	getToolUseSummary(params) {
		return formatQuerySummary("Log Pipeline activity", [
			params.subject,
			params.activityType,
		]);
	},
	getActivityDescription: () => "Logging Pipeline activity",
	async run(params, { respond, signal }) {
		const config = getPipelineConfig();
		if (!config) {
			throw createMissingConfigError();
		}

		const payload = {
			owner_type: params.ownerType,
			owner_id: params.ownerId,
			activity_type: params.activityType,
			channel: params.channel,
			direction: params.direction ?? "outbound",
			...(params.subject ? { subject: params.subject } : {}),
			...(params.body ? { body: params.body } : {}),
			...(params.outcome ? { outcome: params.outcome } : {}),
			...(params.occurredAt ? { occurred_at: params.occurredAt } : {}),
		};

		const result = await pipelineFetch<PipelineActivity>(
			config,
			"POST",
			"/api/v1/activities",
			{
				signal,
				body: payload,
				headers: idempotencyHeaders(),
			},
		);

		respond.text(
			`Logged Pipeline activity${result.id ? ` ${result.id}` : ""} for ${params.ownerType} ${params.ownerId}.`,
		);
		respond.detail(result);
		return respond;
	},
});
