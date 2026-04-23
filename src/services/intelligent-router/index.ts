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
	ROUTING_STRATEGIES,
	type ModelPerformanceAggregate,
	type ModelPerformanceMetricInput,
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
