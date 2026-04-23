export const ATTRIBUTION_MODELS = [
	"direct",
	"assisted",
	"influenced",
	"custom",
] as const;

export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export type AttributionJsonValue =
	| string
	| number
	| boolean
	| null
	| AttributionJsonValue[]
	| { [key: string]: AttributionJsonValue };

export interface RevenueOutcomeInput {
	workspaceId: string;
	agentId: string;
	actionId?: string;
	traceId?: string;
	outcomeId: string;
	outcomeType: string;
	attributionModel?: AttributionModel;
	attributionWeight?: number;
	attributionWeightBps?: number;
	revenueUsd?: number;
	pipelineValueUsd?: number;
	costUsd?: number;
	durationMs?: number;
	occurredAt?: Date | string;
	metadata?: Record<string, unknown>;
}

export interface NormalizedRevenueOutcome {
	workspaceId: string;
	agentId: string;
	outcomeId: string;
	outcomeType: string;
	attributionModel: AttributionModel;
	attributionWeightBps: number;
	revenueUsdMicros: number;
	pipelineValueUsdMicros: number;
	costUsdMicros: number;
	durationMs: number;
	occurredAt: Date;
	metadata: Record<string, AttributionJsonValue>;
	actionId?: string;
	traceId?: string;
}

export interface RevenueAttributionRecord {
	id: string;
	workspaceId: string;
	agentId: string;
	outcomeId: string;
	outcomeType: string;
	attributionModel: AttributionModel;
	attributionWeightBps: number;
	revenueUsd: number;
	pipelineValueUsd: number;
	costUsd: number;
	durationMs: number;
	occurredAt: string;
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, AttributionJsonValue>;
	actionId?: string;
	traceId?: string;
}

export interface RevenueAttributionRoiQuery {
	agentId: string;
	workspaceId?: string;
	from?: Date;
	to?: Date;
}

export interface RevenueAttributionOutcomeSummary {
	outcomeType: string;
	outcomeCount: number;
	revenueUsd: number;
	pipelineValueUsd: number;
	costUsd: number;
}

export interface RevenueAttributionRoiReport {
	agentId: string;
	workspaceId?: string;
	period: {
		from?: string;
		to?: string;
	};
	attribution: {
		outcomeCount: number;
		actionCount: number;
		traceCount: number;
		revenueUsd: number;
		pipelineValueUsd: number;
	};
	cost: {
		costUsd: number;
		totalDurationMs: number;
	};
	roi: {
		revenuePerDollarSpent: number | null;
		netRevenueUsd: number;
		costPerOutcome: number | null;
	};
	byOutcomeType: RevenueAttributionOutcomeSummary[];
}
