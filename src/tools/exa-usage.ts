export interface ExaTelemetryEvent {
	toolName?: string;
	operation?: string;
	endpoint: string;
	attempt: number;
	durationMs: number;
	status?: number;
	success: boolean;
	requestId?: string;
	costDollars?: number;
	errorMessage?: string;
	timestamp: number;
}

export interface ExaUsageEvent {
	timestamp: number;
	endpoint: string;
	operation?: string;
	success: boolean;
	status?: number;
	durationMs: number;
	costDollars?: number;
}

export interface ExaUsageSummary {
	totalCalls: number;
	successes: number;
	failures: number;
	totalDurationMs: number;
	totalCostDollars: number;
	lastEvents: ExaUsageEvent[];
}

const MAX_EVENTS = 5;

const summary: ExaUsageSummary = {
	totalCalls: 0,
	successes: 0,
	failures: 0,
	totalDurationMs: 0,
	totalCostDollars: 0,
	lastEvents: [],
};

export function trackExaUsage(event: ExaTelemetryEvent): void {
	summary.totalCalls += 1;
	summary.totalDurationMs += event.durationMs;
	if (event.costDollars) {
		summary.totalCostDollars += event.costDollars;
	}
	if (event.success) {
		summary.successes += 1;
	} else {
		summary.failures += 1;
	}

	const usageEvent: ExaUsageEvent = {
		timestamp: event.timestamp,
		endpoint: event.endpoint,
		operation: event.operation,
		success: event.success,
		status: event.status,
		durationMs: event.durationMs,
		costDollars: event.costDollars,
	};
	summary.lastEvents.unshift(usageEvent);
	if (summary.lastEvents.length > MAX_EVENTS) {
		summary.lastEvents.length = MAX_EVENTS;
	}
}

export function getExaUsageSummary(): ExaUsageSummary | null {
	return summary.totalCalls === 0
		? null
		: { ...summary, lastEvents: [...summary.lastEvents] };
}

export function resetExaUsageSummaryForTests(): void {
	summary.totalCalls = 0;
	summary.successes = 0;
	summary.failures = 0;
	summary.totalDurationMs = 0;
	summary.totalCostDollars = 0;
	summary.lastEvents = [];
}
