export const ROUTING_STRATEGIES = [
	"balanced",
	"quality",
	"cost",
	"latency",
] as const;

export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export interface RoutingModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface RoutingModelCandidate {
	provider: string;
	model: string;
	name?: string;
	cost?: RoutingModelCost;
	available?: boolean;
}

export interface ModelPerformanceMetricInput {
	taskType: string;
	provider: string;
	model: string;
	latencyMs?: number;
	success?: boolean;
	costUsd?: number;
	qualityScore?: number;
	occurredAt?: Date | string;
}

export interface ModelPerformanceAggregate {
	taskType: string;
	provider: string;
	model: string;
	samples: number;
	successCount: number;
	successRate: number;
	averageLatencyMs: number;
	p95LatencyMs: number;
	averageCostUsd: number;
	qualityScore: number;
	updatedAt: string;
}

export interface RoutingRequestInput {
	taskType?: string;
	modelHint?: string;
	model_hint?: string;
	strategy?: string;
	unavailableModels?: string[] | string;
	unavailable_models?: string[] | string;
	availableModels?: RoutingModelCandidate[];
}

export interface RoutingRequest {
	taskType: string;
	modelHint?: string;
	strategy: RoutingStrategy;
	unavailableModels: string[];
	availableModels: RoutingModelCandidate[];
}

export interface RoutingScore {
	provider: string;
	model: string;
	score: number;
	successRate: number;
	latencyScore: number;
	costScore: number;
	qualityScore: number;
	samples: number;
	available: boolean;
	reasons: string[];
}

export interface RoutedModel {
	provider: string;
	model: string;
}

export interface RoutingDecision {
	decisionId: string;
	taskType: string;
	strategy: RoutingStrategy;
	selectedModel: RoutedModel;
	fallbackChain: RoutedModel[];
	scores: RoutingScore[];
	modelHint?: string;
	overrideApplied: boolean;
	reason: string;
	createdAt: string;
}

export interface RoutingOverrideInput {
	taskType: string;
	provider: string;
	model: string;
	reason?: string;
	expiresAt?: Date | string;
}

export interface RoutingOverride {
	taskType: string;
	provider: string;
	model: string;
	reason?: string;
	createdAt: string;
	expiresAt?: string;
}
