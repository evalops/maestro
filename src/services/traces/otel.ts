import { createHash } from "node:crypto";
import { normalizeTraceSpanName } from "./normalize.js";
import type {
	ExecutionTrace,
	ExecutionTraceSpan,
	OpenTelemetryAnyValue,
	OpenTelemetryKeyValue,
	OpenTelemetrySpan,
	OpenTelemetryTraceExport,
	TraceJsonValue,
} from "./types.js";

const OTEL_SCOPE_NAME = "maestro.traces";
const OTEL_SCOPE_VERSION = "1.0.0";

function hashHex(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function toOtelTraceId(traceId: string): string {
	const normalized = traceId.trim().toLowerCase();
	if (/^[0-9a-f]{32}$/.test(normalized)) return normalized;
	return hashHex(traceId, 32);
}

function toOtelSpanId(spanId: string): string {
	const normalized = spanId.trim().toLowerCase();
	if (/^[0-9a-f]{16}$/.test(normalized)) return normalized;
	return hashHex(spanId, 16);
}

function unixNanoFromIso(value: string): string {
	const millis = Date.parse(value);
	if (Number.isNaN(millis)) return "0";
	return (BigInt(millis) * 1_000_000n).toString();
}

function addDurationToIso(startTime: string, durationMs: number): string {
	const millis = Date.parse(startTime);
	if (Number.isNaN(millis)) return startTime;
	return new Date(millis + durationMs).toISOString();
}

function spanStartTime(
	trace: ExecutionTrace,
	span: ExecutionTraceSpan,
): string {
	return span.startTime ?? trace.createdAt;
}

function spanEndTime(trace: ExecutionTrace, span: ExecutionTraceSpan): string {
	if (span.endTime) return span.endTime;
	if (span.durationMs !== undefined) {
		return addDurationToIso(spanStartTime(trace, span), span.durationMs);
	}
	return spanStartTime(trace, span);
}

function toOtelAnyValue(value: TraceJsonValue): OpenTelemetryAnyValue {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number") {
		if (Number.isInteger(value)) return { intValue: String(value) };
		return { doubleValue: value };
	}
	if (value === null) return { stringValue: "null" };
	if (Array.isArray(value)) {
		return { arrayValue: { values: value.map(toOtelAnyValue) } };
	}
	return {
		kvlistValue: {
			values: Object.entries(value).map(([key, nestedValue]) => ({
				key,
				value: toOtelAnyValue(nestedValue),
			})),
		},
	};
}

function attribute(key: string, value: TraceJsonValue): OpenTelemetryKeyValue {
	return {
		key,
		value: toOtelAnyValue(value),
	};
}

function spanKind(kind: string): string {
	switch (kind) {
		case "llm_inference":
		case "tool_call":
			return "SPAN_KIND_CLIENT";
		case "delegation":
			return "SPAN_KIND_PRODUCER";
		default:
			return "SPAN_KIND_INTERNAL";
	}
}

function statusCode(
	status: ExecutionTraceSpan["status"],
): OpenTelemetrySpan["status"]["code"] {
	if (status === "ok") return "STATUS_CODE_OK";
	if (status === "error") return "STATUS_CODE_ERROR";
	return "STATUS_CODE_UNSET";
}

function spanEvents(
	trace: ExecutionTrace,
	span: ExecutionTraceSpan,
): OpenTelemetrySpan["events"] {
	const events: OpenTelemetrySpan["events"] = [];
	const timeUnixNano = unixNanoFromIso(spanStartTime(trace, span));
	if (span.input !== undefined) {
		events.push({
			name: "input",
			timeUnixNano,
			attributes: [attribute("payload", JSON.stringify(span.input))],
		});
	}
	if (span.output !== undefined) {
		events.push({
			name: "output",
			timeUnixNano: unixNanoFromIso(spanEndTime(trace, span)),
			attributes: [attribute("payload", JSON.stringify(span.output))],
		});
	}
	return events.length > 0 ? events : undefined;
}

function flattenSpans(spans: ExecutionTraceSpan[]): ExecutionTraceSpan[] {
	const flattened: ExecutionTraceSpan[] = [];
	for (const span of spans) {
		flattened.push(span);
		if (span.children) {
			flattened.push(...flattenSpans(span.children));
		}
	}
	return flattened;
}

function toOtelSpan(
	trace: ExecutionTrace,
	span: ExecutionTraceSpan,
): OpenTelemetrySpan {
	const attributes = [
		attribute("maestro.span_kind", span.kind),
		attribute("maestro.trace_status", trace.status),
		attribute("maestro.duration_ms", span.durationMs ?? 0),
		...Object.entries(span.attributes).map(([key, value]) =>
			attribute(key, value),
		),
	];

	const otelSpan: OpenTelemetrySpan = {
		traceId: toOtelTraceId(trace.traceId),
		spanId: toOtelSpanId(span.spanId),
		name: normalizeTraceSpanName(span.name),
		kind: spanKind(span.kind),
		startTimeUnixNano: unixNanoFromIso(spanStartTime(trace, span)),
		endTimeUnixNano: unixNanoFromIso(spanEndTime(trace, span)),
		attributes,
		status: {
			code: statusCode(span.status),
			...(span.error ? { message: span.error } : {}),
		},
	};
	if (span.parentSpanId) {
		otelSpan.parentSpanId = toOtelSpanId(span.parentSpanId);
	}
	const events = spanEvents(trace, span);
	if (events) otelSpan.events = events;
	return otelSpan;
}

export function exportTraceToOpenTelemetry(
	trace: ExecutionTrace,
): OpenTelemetryTraceExport {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						attribute("service.name", "maestro"),
						attribute("maestro.workspace_id", trace.workspaceId),
						attribute("maestro.agent_id", trace.agentId),
						attribute("maestro.trace_id", trace.traceId),
					],
				},
				scopeSpans: [
					{
						scope: {
							name: OTEL_SCOPE_NAME,
							version: OTEL_SCOPE_VERSION,
						},
						spans: flattenSpans(trace.spans).map((span) =>
							toOtelSpan(trace, span),
						),
					},
				],
			},
		],
	};
}
