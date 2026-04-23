export const TRACE_STATUSES = [
	"running",
	"completed",
	"failed",
	"timeout",
] as const;

export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const TRACE_SPAN_STATUSES = ["unset", "ok", "error"] as const;

export type TraceSpanStatus = (typeof TRACE_SPAN_STATUSES)[number];

export type TraceJsonValue =
	| string
	| number
	| boolean
	| null
	| TraceJsonValue[]
	| { [key: string]: TraceJsonValue };

export interface TraceSpanInput {
	spanId?: string;
	parentSpanId?: string | null;
	name: string;
	kind?: string;
	status?: TraceSpanStatus;
	startTime?: Date | string;
	endTime?: Date | string;
	durationMs?: number;
	attributes?: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
	error?: string;
	children?: TraceSpanInput[];
}

export interface ExecutionTraceInput {
	traceId?: string;
	workspaceId: string;
	agentId: string;
	spans: TraceSpanInput[];
	durationMs?: number;
	status?: TraceStatus;
	createdAt?: Date | string;
}

export interface ExecutionTraceSpan {
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: string;
	status: TraceSpanStatus;
	startTime?: string;
	endTime?: string;
	durationMs?: number;
	attributes: Record<string, TraceJsonValue>;
	input?: TraceJsonValue;
	output?: TraceJsonValue;
	error?: string;
	children?: ExecutionTraceSpan[];
}

export interface ExecutionTrace {
	traceId: string;
	workspaceId: string;
	agentId: string;
	spans: ExecutionTraceSpan[];
	durationMs: number;
	status: TraceStatus;
	createdAt: string;
}

export interface ExecutionTraceSummary {
	traceId: string;
	workspaceId: string;
	agentId: string;
	durationMs: number;
	status: TraceStatus;
	spanCount: number;
	createdAt: string;
}

export interface TraceListQuery {
	workspaceId?: string;
	agentId?: string;
	status?: TraceStatus;
	limit: number;
	offset: number;
}

export interface TraceListResult {
	traces: ExecutionTraceSummary[];
	pagination: {
		limit: number;
		offset: number;
		nextOffset?: number;
		hasMore: boolean;
	};
}

export interface OpenTelemetryAnyValue {
	stringValue?: string;
	boolValue?: boolean;
	intValue?: string;
	doubleValue?: number;
	arrayValue?: { values: OpenTelemetryAnyValue[] };
	kvlistValue?: { values: OpenTelemetryKeyValue[] };
}

export interface OpenTelemetryKeyValue {
	key: string;
	value: OpenTelemetryAnyValue;
}

export interface OpenTelemetrySpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OpenTelemetryKeyValue[];
	status: {
		code: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR";
		message?: string;
	};
	events?: Array<{
		name: string;
		timeUnixNano: string;
		attributes: OpenTelemetryKeyValue[];
	}>;
}

export interface OpenTelemetryTraceExport {
	resourceSpans: Array<{
		resource: {
			attributes: OpenTelemetryKeyValue[];
		};
		scopeSpans: Array<{
			scope: {
				name: string;
				version: string;
			};
			spans: OpenTelemetrySpan[];
		}>;
	}>;
}
