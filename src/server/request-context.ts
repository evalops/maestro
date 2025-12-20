import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

export interface RequestContext {
	requestId: string;
	traceId: string;
	spanId: string;
	startTime: number;
	method: string;
	url: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

// W3C Trace Context
// Version (2 hex) - TraceID (32 hex) - ParentSpanID (16 hex) - Flags (2 hex)
// Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
const TRACEPARENT_VERSION = "00";
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/i;
const FLAGS_REGEX = /^[0-9a-f]{2}$/i;

function createTraceId(): string {
	return randomUUID().replace(/-/g, "");
}

function isNonZeroHex(value: string): boolean {
	return !/^0+$/.test(value);
}

function isValidTraceId(traceId: string): boolean {
	return TRACE_ID_REGEX.test(traceId) && isNonZeroHex(traceId);
}

function isValidSpanId(spanId: string): boolean {
	return SPAN_ID_REGEX.test(spanId) && isNonZeroHex(spanId);
}

function isValidTraceFlags(flags: string): boolean {
	return FLAGS_REGEX.test(flags);
}

export function parseTraceParent(header?: string | string[]): {
	traceId: string;
	parentSpanId?: string;
} {
	if (!header || typeof header !== "string") {
		return {
			traceId: createTraceId(),
		};
	}

	const parts = header.split("-");
	if (parts.length !== 4 || parts[0] !== TRACEPARENT_VERSION) {
		return {
			traceId: createTraceId(),
		};
	}

	const [_, traceId, parentSpanId, flags] = parts;
	if (
		!isValidTraceId(traceId) ||
		!isValidSpanId(parentSpanId) ||
		!isValidTraceFlags(flags)
	) {
		return {
			traceId: createTraceId(),
		};
	}

	return {
		traceId: traceId.toLowerCase(),
		parentSpanId: parentSpanId.toLowerCase(),
	};
}

export function getRequestId(): string {
	const store = requestContextStorage.getStore();
	return store?.requestId || "unknown";
}

export function getTraceContext():
	| { traceId: string; spanId: string }
	| undefined {
	const store = requestContextStorage.getStore();
	if (!store) return undefined;
	return { traceId: store.traceId, spanId: store.spanId };
}

export function getTraceParentHeader(): string | undefined {
	const store = requestContextStorage.getStore();
	if (!store) return undefined;
	return `00-${store.traceId}-${store.spanId}-01`;
}

export function getRequestContext(): RequestContext | undefined {
	return requestContextStorage.getStore();
}
