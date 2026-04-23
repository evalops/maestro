export const USAGE_ANALYTICS_PERIODS = ["daily", "weekly", "monthly"] as const;

export type UsageAnalyticsPeriod = (typeof USAGE_ANALYTICS_PERIODS)[number];

export interface UsageTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageMetricInput {
	workspaceId: string;
	agentId: string;
	sessionId?: string;
	provider: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	occurredAt?: Date;
}

export interface NormalizedUsageMetric {
	workspaceId: string;
	agentId: string;
	sessionId?: string;
	provider: string;
	model: string;
	bucketStart: Date;
	occurredAt: Date;
	callCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface UsageAnalyticsQuery {
	period: UsageAnalyticsPeriod;
	workspaceId?: string;
	agentId?: string;
	provider?: string;
	model?: string;
	from?: Date;
	to?: Date;
}

export interface UsageAnalyticsBucket {
	bucketStart: string;
	workspaceId: string;
	agentId: string;
	provider: string;
	model: string;
	calls: number;
	tokens: UsageTokenTotals;
	costUsd: number;
}

export interface UsageAnalyticsTotals {
	calls: number;
	tokens: UsageTokenTotals;
	costUsd: number;
}

export interface UsageAnalyticsReport {
	period: UsageAnalyticsPeriod;
	filters: {
		workspaceId?: string;
		agentId?: string;
		provider?: string;
		model?: string;
		from?: string;
		to?: string;
	};
	totals: UsageAnalyticsTotals;
	buckets: UsageAnalyticsBucket[];
}

export interface UsageAnalyticsRecordResult {
	recorded: boolean;
	reason?: "database_unconfigured";
}
