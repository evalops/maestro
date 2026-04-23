import { createHash } from "node:crypto";
import {
	IntelligentRouterValidationError,
	normalizePerformanceMetricInput,
	normalizeRoutingOverrideInput,
	normalizeRoutingRequest,
} from "./normalize.js";
import type {
	ModelPerformanceAggregate,
	ModelPerformanceMetricInput,
	RoutedModel,
	RoutingDecision,
	RoutingModelCandidate,
	RoutingOverride,
	RoutingOverrideInput,
	RoutingRequestInput,
	RoutingScore,
	RoutingStrategy,
} from "./types.js";

const MIN_HISTORY_SAMPLES = 2;
const MAX_LATENCIES = 100;
const MAX_DECISIONS = 100;

interface MetricState {
	taskType: string;
	provider: string;
	model: string;
	samples: number;
	successCount: number;
	totalLatencyMs: number;
	latenciesMs: number[];
	totalCostUsd: number;
	qualityScoreTotal: number;
	updatedAt: Date;
}

interface StrategyWeights {
	success: number;
	latency: number;
	cost: number;
	quality: number;
}

const STRATEGY_WEIGHTS: Record<RoutingStrategy, StrategyWeights> = {
	balanced: { success: 0.45, latency: 0.25, cost: 0.2, quality: 0.1 },
	quality: { success: 0.3, latency: 0.05, cost: 0.05, quality: 0.6 },
	cost: { success: 0.25, latency: 0.15, cost: 0.55, quality: 0.05 },
	latency: { success: 0.3, latency: 0.55, cost: 0.1, quality: 0.05 },
};

function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function metricKey(taskType: string, provider: string, model: string): string {
	return `${taskType}:${modelKey(provider, model)}`;
}

function normalizeModelRef(value: string): string {
	return value.trim().toLowerCase();
}

function decisionId(payload: unknown): string {
	return `route_${createHash("sha256")
		.update(JSON.stringify(payload))
		.digest("hex")
		.slice(0, 16)}`;
}

function percentile(values: number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	);
	return sorted[index] ?? 0;
}

function aggregateFromState(state: MetricState): ModelPerformanceAggregate {
	return {
		taskType: state.taskType,
		provider: state.provider,
		model: state.model,
		samples: state.samples,
		successCount: state.successCount,
		successRate: state.samples > 0 ? state.successCount / state.samples : 0,
		averageLatencyMs:
			state.samples > 0 ? state.totalLatencyMs / state.samples : 0,
		p95LatencyMs: percentile(state.latenciesMs, 0.95),
		averageCostUsd: state.samples > 0 ? state.totalCostUsd / state.samples : 0,
		qualityScore:
			state.samples > 0 ? state.qualityScoreTotal / state.samples : 0.5,
		updatedAt: state.updatedAt.toISOString(),
	};
}

function candidateKey(candidate: RoutingModelCandidate): string {
	return modelKey(candidate.provider, candidate.model);
}

function modelMatchesHint(
	candidate: RoutingModelCandidate,
	hint: string | undefined,
): boolean {
	if (!hint) return false;
	const normalizedHint = normalizeModelRef(hint);
	const candidateRefs = [
		candidate.model,
		candidateKey(candidate),
		`${candidate.provider}:${candidate.model}`,
	];
	return candidateRefs.some(
		(candidateRef) => normalizeModelRef(candidateRef) === normalizedHint,
	);
}

function costEstimate(candidate: RoutingModelCandidate): number | undefined {
	const cost = candidate.cost;
	if (!cost) return undefined;
	const values = [
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
	].filter(
		(value): value is number =>
			typeof value === "number" && Number.isFinite(value),
	);
	if (values.length === 0) return undefined;
	return values.reduce((total, value) => total + value, 0) / values.length;
}

function costScore(
	aggregate: ModelPerformanceAggregate | undefined,
	candidate: RoutingModelCandidate,
): number {
	const cost = aggregate?.samples
		? aggregate.averageCostUsd
		: costEstimate(candidate);
	if (cost === undefined || cost <= 0) return 0.5;
	return 1 / (1 + cost);
}

function latencyScore(
	aggregate: ModelPerformanceAggregate | undefined,
): number {
	if (!aggregate?.samples) return 0.5;
	const latency = aggregate.p95LatencyMs || aggregate.averageLatencyMs;
	return Math.max(0, 1 - Math.min(latency, 30_000) / 30_000);
}

function successScore(
	aggregate: ModelPerformanceAggregate | undefined,
): number {
	if (!aggregate?.samples) return 0.5;
	return aggregate.successRate;
}

function qualityScore(
	aggregate: ModelPerformanceAggregate | undefined,
): number {
	if (!aggregate?.samples) return 0.5;
	return aggregate.qualityScore;
}

function scoreCandidate(params: {
	candidate: RoutingModelCandidate;
	aggregate?: ModelPerformanceAggregate;
	strategy: RoutingStrategy;
	available: boolean;
}): RoutingScore {
	const weights = STRATEGY_WEIGHTS[params.strategy];
	const success = successScore(params.aggregate);
	const latency = latencyScore(params.aggregate);
	const cost = costScore(params.aggregate, params.candidate);
	const quality = qualityScore(params.aggregate);
	const score = params.available
		? success * weights.success +
			latency * weights.latency +
			cost * weights.cost +
			quality * weights.quality
		: -1;
	const reasons = [
		`success=${success.toFixed(2)}`,
		`latency=${latency.toFixed(2)}`,
		`cost=${cost.toFixed(2)}`,
		`quality=${quality.toFixed(2)}`,
	];
	if (!params.available) {
		reasons.push("unavailable");
	}
	if (!params.aggregate?.samples) {
		reasons.push("cold_start");
	}
	return {
		provider: params.candidate.provider,
		model: params.candidate.model,
		score,
		successRate: success,
		latencyScore: latency,
		costScore: cost,
		qualityScore: quality,
		samples: params.aggregate?.samples ?? 0,
		available: params.available,
		reasons,
	};
}

function routedModelFromScore(score: RoutingScore): RoutedModel {
	return {
		provider: score.provider,
		model: score.model,
	};
}

function overrideExpired(override: RoutingOverride, now: Date): boolean {
	return override.expiresAt
		? Date.parse(override.expiresAt) <= now.getTime()
		: false;
}

export class IntelligentRouterService {
	private readonly metrics = new Map<string, MetricState>();
	private readonly overrides = new Map<string, RoutingOverride>();
	private readonly decisions: RoutingDecision[] = [];

	constructor(
		private readonly defaultModels: () => RoutingModelCandidate[] = () => [],
		private readonly now: () => Date = () => new Date(),
	) {}

	recordPerformanceMetric(
		input: ModelPerformanceMetricInput,
	): ModelPerformanceAggregate {
		const metric = normalizePerformanceMetricInput(input);
		const key = metricKey(metric.taskType, metric.provider, metric.model);
		const existing = this.metrics.get(key);
		const state =
			existing ??
			({
				taskType: metric.taskType,
				provider: metric.provider,
				model: metric.model,
				samples: 0,
				successCount: 0,
				totalLatencyMs: 0,
				latenciesMs: [],
				totalCostUsd: 0,
				qualityScoreTotal: 0,
				updatedAt: this.now(),
			} satisfies MetricState);

		state.samples += 1;
		if (metric.success) state.successCount += 1;
		state.totalLatencyMs += metric.latencyMs;
		state.latenciesMs.push(metric.latencyMs);
		if (state.latenciesMs.length > MAX_LATENCIES) {
			state.latenciesMs.splice(0, state.latenciesMs.length - MAX_LATENCIES);
		}
		state.totalCostUsd += metric.costUsd;
		state.qualityScoreTotal += metric.qualityScore;
		state.updatedAt =
			metric.occurredAt instanceof Date
				? metric.occurredAt
				: new Date(metric.occurredAt);
		this.metrics.set(key, state);
		return aggregateFromState(state);
	}

	routeRequest(input: RoutingRequestInput): RoutingDecision {
		const request = normalizeRoutingRequest(input, this.defaultModels());
		if (request.availableModels.length === 0) {
			throw new IntelligentRouterValidationError(
				"No available models were provided for routing.",
			);
		}

		this.pruneExpiredOverrides();
		const unavailable = new Set(
			request.unavailableModels.map((entry) => normalizeModelRef(entry)),
		);
		const scores = request.availableModels
			.map((candidate) => {
				const aggregate = this.getAggregate(
					request.taskType,
					candidate.provider,
					candidate.model,
				);
				const available =
					candidate.available !== false &&
					!unavailable.has(normalizeModelRef(candidate.model)) &&
					!unavailable.has(normalizeModelRef(candidateKey(candidate)));
				return scoreCandidate({
					candidate,
					aggregate,
					strategy: request.strategy,
					available,
				});
			})
			.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));

		const availableScores = scores.filter((score) => score.available);
		if (availableScores.length === 0) {
			throw new IntelligentRouterValidationError(
				"All models are marked unavailable.",
			);
		}
		const firstAvailable = availableScores[0];
		if (!firstAvailable) {
			throw new IntelligentRouterValidationError(
				"All models are marked unavailable.",
			);
		}

		const override = this.overrides.get(request.taskType);
		const overrideScore =
			override && !overrideExpired(override, this.now())
				? availableScores.find(
						(score) =>
							score.provider === override.provider &&
							score.model === override.model,
					)
				: undefined;
		const hintScore = request.modelHint
			? availableScores.find((score) =>
					modelMatchesHint(
						{ provider: score.provider, model: score.model },
						request.modelHint,
					),
				)
			: undefined;
		const enoughHistory = availableScores.some(
			(score) => score.samples >= MIN_HISTORY_SAMPLES,
		);
		const selectedScore =
			overrideScore ??
			(!enoughHistory && hintScore ? hintScore : firstAvailable);
		const overrideApplied = overrideScore !== undefined;
		const reason = overrideApplied
			? "override"
			: !enoughHistory && hintScore
				? "insufficient_history_model_hint"
				: "highest_score";
		const selected = routedModelFromScore(selectedScore);
		const fallbackChain = availableScores
			.filter(
				(score) =>
					score.provider !== selected.provider ||
					score.model !== selected.model,
			)
			.map(routedModelFromScore);
		const createdAt = this.now().toISOString();
		const decision: RoutingDecision = {
			decisionId: decisionId({
				taskType: request.taskType,
				strategy: request.strategy,
				selected,
				createdAt,
			}),
			taskType: request.taskType,
			strategy: request.strategy,
			selectedModel: selected,
			fallbackChain,
			scores,
			overrideApplied,
			reason,
			createdAt,
			...(request.modelHint ? { modelHint: request.modelHint } : {}),
		};
		this.decisions.unshift(decision);
		if (this.decisions.length > MAX_DECISIONS) {
			this.decisions.splice(MAX_DECISIONS);
		}
		return decision;
	}

	setOverride(input: RoutingOverrideInput): RoutingOverride {
		const overrideInput = normalizeRoutingOverrideInput(input);
		const expiresAt =
			overrideInput.expiresAt instanceof Date
				? overrideInput.expiresAt.toISOString()
				: overrideInput.expiresAt;
		const override: RoutingOverride = {
			taskType: overrideInput.taskType,
			provider: overrideInput.provider,
			model: overrideInput.model,
			createdAt: this.now().toISOString(),
			...(overrideInput.reason ? { reason: overrideInput.reason } : {}),
			...(expiresAt ? { expiresAt } : {}),
		};
		this.overrides.set(override.taskType, override);
		return override;
	}

	deleteOverride(taskType: string): boolean {
		return this.overrides.delete(taskType.trim());
	}

	listOverrides(): RoutingOverride[] {
		this.pruneExpiredOverrides();
		return Array.from(this.overrides.values()).sort((a, b) =>
			a.taskType.localeCompare(b.taskType),
		);
	}

	listMetrics(taskType?: string): ModelPerformanceAggregate[] {
		const aggregates = Array.from(this.metrics.values()).map(
			aggregateFromState,
		);
		const filtered = taskType
			? aggregates.filter((metric) => metric.taskType === taskType)
			: aggregates;
		return filtered.sort(
			(a, b) =>
				a.taskType.localeCompare(b.taskType) ||
				a.provider.localeCompare(b.provider) ||
				a.model.localeCompare(b.model),
		);
	}

	listDecisions(limit = 20): RoutingDecision[] {
		const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
		return this.decisions.slice(0, normalizedLimit);
	}

	clearForTest(): void {
		this.metrics.clear();
		this.overrides.clear();
		this.decisions.length = 0;
	}

	private getAggregate(
		taskType: string,
		provider: string,
		model: string,
	): ModelPerformanceAggregate | undefined {
		const state = this.metrics.get(metricKey(taskType, provider, model));
		return state ? aggregateFromState(state) : undefined;
	}

	private pruneExpiredOverrides(): void {
		const now = this.now();
		for (const [taskType, override] of this.overrides) {
			if (overrideExpired(override, now)) {
				this.overrides.delete(taskType);
			}
		}
	}
}

let defaultIntelligentRouterService: IntelligentRouterService | null = null;

export function getIntelligentRouterService(): IntelligentRouterService {
	defaultIntelligentRouterService ??= new IntelligentRouterService();
	return defaultIntelligentRouterService;
}

export function setIntelligentRouterServiceForTest(
	service: IntelligentRouterService | null,
): void {
	defaultIntelligentRouterService = service;
}
