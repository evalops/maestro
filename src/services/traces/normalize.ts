import { randomBytes } from "node:crypto";
import {
	type ExecutionTrace,
	type ExecutionTraceInput,
	type ExecutionTraceSpan,
	TRACE_SPAN_STATUSES,
	TRACE_STATUSES,
	type TraceJsonValue,
	type TraceListQuery,
	type TraceSpanInput,
	type TraceSpanStatus,
	type TraceStatus,
} from "./types.js";

const MAX_TRACE_ID_LENGTH = 64;
const DEFAULT_TRACE_LIST_LIMIT = 50;
const MAX_TRACE_LIST_LIMIT = 100;

export class TracesValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TracesValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRequiredString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new TracesValidationError(`${label} is required.`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new TracesValidationError(`${label} is required.`);
	}
	return trimmed;
}

export function normalizeTraceSpanName(value: unknown): string {
	const normalized = cleanRequiredString(value, "span.name")
		.replace(/[\\/\s]+/gu, ".")
		.replace(/\.+/gu, ".")
		.replace(/^\.+|\.+$/gu, "");
	if (!normalized) {
		throw new TracesValidationError("span.name is required.");
	}
	return normalized;
}

function cleanOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function generateTraceId(): string {
	return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
	return randomBytes(8).toString("hex");
}

export function parseTraceStatus(value: unknown): TraceStatus {
	const normalized =
		typeof value === "string" ? value.trim().toLowerCase() : "completed";
	if (TRACE_STATUSES.includes(normalized as TraceStatus)) {
		return normalized as TraceStatus;
	}
	throw new TracesValidationError(
		"Invalid trace status. Use running, completed, failed, or timeout.",
	);
}

function parseTraceSpanStatus(
	value: unknown,
	hasError: boolean,
): TraceSpanStatus {
	const normalized =
		typeof value === "string"
			? value.trim().toLowerCase()
			: hasError
				? "error"
				: "ok";
	if (TRACE_SPAN_STATUSES.includes(normalized as TraceSpanStatus)) {
		return normalized as TraceSpanStatus;
	}
	throw new TracesValidationError(
		"Invalid span status. Use unset, ok, or error.",
	);
}

function normalizeTraceId(value: unknown): string {
	const traceId = cleanOptionalString(value) ?? generateTraceId();
	if (traceId.length > MAX_TRACE_ID_LENGTH) {
		throw new TracesValidationError(
			`traceId must be ${MAX_TRACE_ID_LENGTH} characters or fewer.`,
		);
	}
	return traceId;
}

function parseDate(
	value: Date | string | null | undefined,
	label: string,
): Date | undefined {
	if (value === undefined) return undefined;
	if (value === null) {
		throw new TracesValidationError(`${label} must be a valid date.`);
	}
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new TracesValidationError(`${label} must be a valid date.`);
	}
	return parsed;
}

function normalizeNonNegativeInteger(
	value: unknown,
	label: string,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TracesValidationError(`${label} must be a finite number.`);
	}
	if (value < 0) {
		throw new TracesValidationError(`${label} must be non-negative.`);
	}
	return Math.floor(value);
}

function sanitizeJsonValue(
	value: unknown,
	depth = 0,
): TraceJsonValue | undefined {
	if (depth > 12) return String(value);
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeJsonValue(item, depth + 1))
			.filter((item): item is TraceJsonValue => item !== undefined);
	}
	if (isRecord(value)) {
		const result: Record<string, TraceJsonValue> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			const sanitized = sanitizeJsonValue(nestedValue, depth + 1);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

function normalizeAttributes(
	value: Record<string, unknown> | undefined,
): Record<string, TraceJsonValue> {
	if (!value) return {};
	const attributes: Record<string, TraceJsonValue> = {};
	for (const [key, attributeValue] of Object.entries(value)) {
		const sanitized = sanitizeJsonValue(attributeValue);
		if (sanitized !== undefined) {
			attributes[key] = sanitized;
		}
	}
	return attributes;
}

function inferDurationMs(startTime?: Date, endTime?: Date): number | undefined {
	if (!startTime || !endTime) return undefined;
	const duration = endTime.getTime() - startTime.getTime();
	return duration >= 0 ? duration : undefined;
}

function normalizeSpan(
	input: TraceSpanInput,
	parentSpanId?: string,
): ExecutionTraceSpan {
	if (!isRecord(input)) {
		throw new TracesValidationError("Each span must be an object.");
	}
	const error = cleanOptionalString(input.error);
	const spanId = cleanOptionalString(input.spanId) ?? generateSpanId();
	const startTime = parseDate(input.startTime, "span.startTime");
	const endTime = parseDate(input.endTime, "span.endTime");
	const durationMs =
		normalizeNonNegativeInteger(input.durationMs, "span.durationMs") ??
		inferDurationMs(startTime, endTime);

	const children = Array.isArray(input.children)
		? input.children.map((child) => normalizeSpan(child, spanId))
		: undefined;

	const normalized: ExecutionTraceSpan = {
		spanId,
		name: normalizeTraceSpanName(input.name),
		kind: cleanOptionalString(input.kind) ?? "internal",
		status: parseTraceSpanStatus(input.status, Boolean(error)),
		attributes: normalizeAttributes(input.attributes),
	};
	const resolvedParentSpanId =
		cleanOptionalString(input.parentSpanId) ?? parentSpanId;
	if (resolvedParentSpanId) normalized.parentSpanId = resolvedParentSpanId;
	if (startTime) normalized.startTime = startTime.toISOString();
	if (endTime) normalized.endTime = endTime.toISOString();
	if (durationMs !== undefined) normalized.durationMs = durationMs;
	if (input.input !== undefined) {
		const sanitizedInput = sanitizeJsonValue(input.input);
		if (sanitizedInput !== undefined) normalized.input = sanitizedInput;
	}
	if (input.output !== undefined) {
		const sanitizedOutput = sanitizeJsonValue(input.output);
		if (sanitizedOutput !== undefined) normalized.output = sanitizedOutput;
	}
	if (error) normalized.error = error;
	if (children && children.length > 0) normalized.children = children;
	return normalized;
}

function maxSpanDurationMs(spans: ExecutionTraceSpan[]): number {
	let max = 0;
	for (const span of spans) {
		if (typeof span.durationMs === "number" && span.durationMs > max) {
			max = span.durationMs;
		}
		if (span.children) {
			max = Math.max(max, maxSpanDurationMs(span.children));
		}
	}
	return max;
}

export function countTraceSpans(spans: ExecutionTraceSpan[]): number {
	let count = 0;
	for (const span of spans) {
		count += 1;
		if (span.children) {
			count += countTraceSpans(span.children);
		}
	}
	return count;
}

export function normalizeExecutionTraceInput(
	input: ExecutionTraceInput,
): ExecutionTrace {
	if (!isRecord(input)) {
		throw new TracesValidationError("Trace payload must be an object.");
	}
	if (!Array.isArray(input.spans)) {
		throw new TracesValidationError("spans must be an array.");
	}
	const spans = input.spans.map((span) => normalizeSpan(span));
	const createdAt = parseDate(input.createdAt, "createdAt") ?? new Date();
	const durationMs =
		normalizeNonNegativeInteger(input.durationMs, "durationMs") ??
		maxSpanDurationMs(spans);

	return {
		traceId: normalizeTraceId(input.traceId),
		workspaceId: cleanRequiredString(input.workspaceId, "workspaceId"),
		agentId: cleanRequiredString(input.agentId, "agentId"),
		spans,
		durationMs,
		status: parseTraceStatus(input.status),
		createdAt: createdAt.toISOString(),
	};
}

export function parseTraceLimit(value: string | null | undefined): number {
	if (!value) return DEFAULT_TRACE_LIST_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new TracesValidationError("limit must be a positive integer.");
	}
	return Math.min(parsed, MAX_TRACE_LIST_LIMIT);
}

export function parseTraceOffset(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new TracesValidationError("offset must be a non-negative integer.");
	}
	return parsed;
}

export function normalizeTraceListQuery(params: {
	workspaceId?: string;
	agentId?: string;
	status?: string;
	limit?: string | null;
	offset?: string | null;
}): TraceListQuery {
	return {
		...(params.workspaceId
			? { workspaceId: cleanRequiredString(params.workspaceId, "workspaceId") }
			: {}),
		...(params.agentId
			? { agentId: cleanRequiredString(params.agentId, "agentId") }
			: {}),
		...(params.status ? { status: parseTraceStatus(params.status) } : {}),
		limit: parseTraceLimit(params.limit),
		offset: parseTraceOffset(params.offset),
	};
}
