export {
	IntelligentRouterValidationError,
	normalizePerformanceMetricInput,
	normalizeRoutingOverrideInput,
	normalizeRoutingRequest,
	parseRoutingStrategy,
} from "./normalize.js";
export {
	recordIntelligentRouterChatMetric,
	registeredRoutingModels,
	resolveIntelligentRouterStrategy,
	resolveIntelligentRouterTaskType,
	selectIntelligentRouterModel,
} from "./recorder.js";
export {
	IntelligentRouterService,
	getIntelligentRouterService,
	setIntelligentRouterServiceForTest,
} from "./service.js";
export {
	MODEL_PERFORMANCE_METRIC_SOURCES,
	ROUTING_STRATEGIES,
	type ModelPerformanceAggregate,
	type ModelPerformanceMetricInput,
	type ModelPerformanceMetricSource,
	type RoutedModel,
	type RoutingDecision,
	type RoutingModelCandidate,
	type RoutingModelCost,
	type RoutingOverride,
	type RoutingOverrideInput,
	type RoutingRequest,
	type RoutingRequestInput,
	type RoutingScore,
	type RoutingStrategy,
} from "./types.js";
