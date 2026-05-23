import type { A2ACockpitSummary } from "../platform/a2a-cockpit.js";
import type {
	ModelPerformanceAggregate,
	RoutingDecision,
} from "../services/intelligent-router/types.js";
import type { AgentTrajectoryReplayLabReport } from "./agent-trajectory-replay-lab.js";
import type { RunHealthSnapshot } from "./handlers/status.js";

export const ANY_AGENT_CONTROL_PLANE_PROOF_SCHEMA =
	"evalops.maestro.any-agent-control-plane-proof.v1";

export type AnyAgentControlPlaneProofStatus =
	| "passed"
	| "needs_attention"
	| "incomplete";

export type AnyAgentControlPlaneCapabilityStatus =
	| "passed"
	| "warning"
	| "failed";

export type AnyAgentControlPlaneCapabilityId =
	| "a2a_discovery"
	| "a2a_delegation"
	| "model_routing"
	| "eval_backed_routing"
	| "runtime_observability"
	| "trajectory_replay"
	| "operator_handoff";

export interface AnyAgentControlPlaneProofInput {
	generatedAt?: string;
	a2a?: A2ACockpitSummary;
	routingDecisions?: RoutingDecision[];
	routeMetrics?: ModelPerformanceAggregate[];
	replayLab?: AgentTrajectoryReplayLabReport;
	runHealth?: RunHealthSnapshot;
}

export interface AnyAgentControlPlaneCapabilityProof {
	id: AnyAgentControlPlaneCapabilityId;
	label: string;
	status: AnyAgentControlPlaneCapabilityStatus;
	evidence: string[];
	blocker?: string;
}

export interface AnyAgentControlPlaneProofReport {
	schemaVersion: typeof ANY_AGENT_CONTROL_PLANE_PROOF_SCHEMA;
	generatedAt: string;
	status: AnyAgentControlPlaneProofStatus;
	summary: {
		capabilities: number;
		passed: number;
		warnings: number;
		failed: number;
		agentsObserved: number;
		routingDecisions: number;
		evalBackedRoutes: number;
	};
	capabilities: AnyAgentControlPlaneCapabilityProof[];
	blockers: string[];
	operatorNextActions: string[];
}

function capability(
	id: AnyAgentControlPlaneCapabilityId,
	label: string,
	status: AnyAgentControlPlaneCapabilityStatus,
	evidence: string[],
	blocker?: string,
): AnyAgentControlPlaneCapabilityProof {
	return {
		id,
		label,
		status,
		evidence,
		...(blocker ? { blocker } : {}),
	};
}

function latestDecision(
	decisions: RoutingDecision[] | undefined,
): RoutingDecision | undefined {
	return decisions?.[0];
}

function hasOnlyEvalSamples(input: {
	evalSamples: number;
	productionSamples: number;
}): boolean {
	return input.evalSamples > 0 && input.productionSamples === 0;
}

function routeCandidateKey(input: {
	taskType: string;
	provider: string;
	model: string;
}): string {
	return `${input.taskType}:${input.provider}/${input.model}`;
}

function countEvalBackedRoutes(input: AnyAgentControlPlaneProofInput): number {
	const routes = new Set<string>();
	for (const metric of input.routeMetrics ?? []) {
		if (hasOnlyEvalSamples(metric)) {
			routes.add(routeCandidateKey(metric));
		}
	}
	for (const decision of input.routingDecisions ?? []) {
		for (const score of decision.scores) {
			if (score.evalBacked || hasOnlyEvalSamples(score)) {
				routes.add(
					routeCandidateKey({
						taskType: decision.taskType,
						provider: score.provider,
						model: score.model,
					}),
				);
			}
		}
	}
	return routes.size;
}

function proveDiscovery(
	a2a: A2ACockpitSummary | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!a2a) {
		return capability(
			"a2a_discovery",
			"A2A discovery",
			"failed",
			[],
			"No A2A cockpit summary was supplied.",
		);
	}
	if (a2a.counts.onlinePeers > 0) {
		return capability("a2a_discovery", "A2A discovery", "passed", [
			`${a2a.counts.onlinePeers}/${a2a.counts.peers} peers online`,
		]);
	}
	if (a2a.counts.peers > 0) {
		return capability(
			"a2a_discovery",
			"A2A discovery",
			"warning",
			[`${a2a.counts.peers} peers registered`],
			"Registered A2A peers are currently unreachable.",
		);
	}
	return capability(
		"a2a_discovery",
		"A2A discovery",
		"failed",
		[],
		"No A2A peers are registered.",
	);
}

function proveDelegation(
	a2a: A2ACockpitSummary | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!a2a) {
		return capability(
			"a2a_delegation",
			"A2A delegation",
			"failed",
			[],
			"No A2A cockpit summary was supplied.",
		);
	}
	const delegateAction = a2a.nextActions.find((action) =>
		action.command.startsWith("maestro a2a delegate "),
	);
	if (a2a.counts.tasks > 0) {
		return capability("a2a_delegation", "A2A delegation", "passed", [
			`${a2a.counts.tasks} delegated tasks tracked`,
		]);
	}
	if (delegateAction) {
		return capability("a2a_delegation", "A2A delegation", "passed", [
			delegateAction.command,
		]);
	}
	return capability(
		"a2a_delegation",
		"A2A delegation",
		a2a.counts.onlinePeers > 0 ? "warning" : "failed",
		[],
		"No active task or delegation command is available.",
	);
}

function proveRouting(
	decision: RoutingDecision | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!decision) {
		return capability(
			"model_routing",
			"Model routing",
			"failed",
			[],
			"No intelligent-router decision was supplied.",
		);
	}
	const selected = `${decision.selectedModel.provider}/${decision.selectedModel.model}`;
	const evidence = [
		`selected ${selected}`,
		`fallbacks ${decision.fallbackChain.length}`,
		`reason ${decision.reason}`,
	];
	return capability(
		"model_routing",
		"Model routing",
		decision.fallbackChain.length > 0 ? "passed" : "warning",
		evidence,
		decision.fallbackChain.length > 0
			? undefined
			: "Routing decision has no fallback chain.",
	);
}

function proveEvalRouting(
	input: AnyAgentControlPlaneProofInput,
): AnyAgentControlPlaneCapabilityProof {
	const evalBackedRoutes = countEvalBackedRoutes(input);
	if (evalBackedRoutes > 0) {
		return capability("eval_backed_routing", "Eval-backed routing", "passed", [
			`${evalBackedRoutes} route candidates have eval samples`,
		]);
	}
	if ((input.routingDecisions?.length ?? 0) > 0) {
		return capability(
			"eval_backed_routing",
			"Eval-backed routing",
			"warning",
			["routing decisions exist"],
			"No route candidate includes eval-backed samples yet.",
		);
	}
	return capability(
		"eval_backed_routing",
		"Eval-backed routing",
		"failed",
		[],
		"No routing decisions or eval metrics were supplied.",
	);
}

function proveObservability(
	runHealth: RunHealthSnapshot | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!runHealth) {
		return capability(
			"runtime_observability",
			"Runtime observability",
			"failed",
			[],
			"No run-health snapshot was supplied.",
		);
	}
	return capability(
		"runtime_observability",
		"Runtime observability",
		runHealth.status === "healthy" ? "passed" : "warning",
		[`runHealth ${runHealth.status}`, `${runHealth.slos.length} SLO lanes`],
		runHealth.status === "healthy"
			? undefined
			: runHealth.diagnostics.join("; ") ||
					`Runtime health is ${runHealth.status}.`,
	);
}

function proveReplay(
	replayLab: AgentTrajectoryReplayLabReport | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!replayLab) {
		return capability(
			"trajectory_replay",
			"Trajectory replay",
			"failed",
			[],
			"No trajectory replay lab report was supplied.",
		);
	}
	if (replayLab.summary.trajectoryEvents === 0) {
		return capability(
			"trajectory_replay",
			"Trajectory replay",
			"failed",
			[],
			"Replay lab has no trajectory events.",
		);
	}
	return capability(
		"trajectory_replay",
		"Trajectory replay",
		replayLab.summary.scoreFailures > 0 ? "warning" : "passed",
		[
			`${replayLab.summary.trajectoryEvents} trajectory events`,
			`${replayLab.summary.scoreFailures} score failures`,
			`${replayLab.summary.jumpTargets} jump targets`,
		],
		replayLab.summary.scoreFailures > 0
			? "Replay lab has score failures."
			: undefined,
	);
}

function proveOperatorHandoff(
	a2a: A2ACockpitSummary | undefined,
): AnyAgentControlPlaneCapabilityProof {
	if (!a2a) {
		return capability(
			"operator_handoff",
			"Operator handoff",
			"failed",
			[],
			"No A2A cockpit summary was supplied.",
		);
	}
	const commands = a2a.nextActions.map((action) => action.command);
	if (commands.length > 0) {
		return capability("operator_handoff", "Operator handoff", "passed", [
			`${commands.length} operator actions available`,
		]);
	}
	return capability(
		"operator_handoff",
		"Operator handoff",
		a2a.counts.peers > 0 ? "warning" : "failed",
		[],
		"No next operator action was produced.",
	);
}

function overallStatus(
	capabilities: AnyAgentControlPlaneCapabilityProof[],
): AnyAgentControlPlaneProofStatus {
	if (capabilities.some((entry) => entry.status === "failed")) {
		return "incomplete";
	}
	if (capabilities.some((entry) => entry.status === "warning")) {
		return "needs_attention";
	}
	return "passed";
}

export function buildAnyAgentControlPlaneProof(
	input: AnyAgentControlPlaneProofInput,
): AnyAgentControlPlaneProofReport {
	const capabilities = [
		proveDiscovery(input.a2a),
		proveDelegation(input.a2a),
		proveRouting(latestDecision(input.routingDecisions)),
		proveEvalRouting(input),
		proveObservability(input.runHealth),
		proveReplay(input.replayLab),
		proveOperatorHandoff(input.a2a),
	];
	const passed = capabilities.filter(
		(entry) => entry.status === "passed",
	).length;
	const warnings = capabilities.filter(
		(entry) => entry.status === "warning",
	).length;
	const failed = capabilities.filter(
		(entry) => entry.status === "failed",
	).length;
	return {
		schemaVersion: ANY_AGENT_CONTROL_PLANE_PROOF_SCHEMA,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		status: overallStatus(capabilities),
		summary: {
			capabilities: capabilities.length,
			passed,
			warnings,
			failed,
			agentsObserved: input.a2a?.counts.peers ?? 0,
			routingDecisions: input.routingDecisions?.length ?? 0,
			evalBackedRoutes: countEvalBackedRoutes(input),
		},
		capabilities,
		blockers: capabilities
			.filter((entry) => entry.blocker)
			.map((entry) => `${entry.label}: ${entry.blocker}`),
		operatorNextActions:
			input.a2a?.nextActions.map((action) => action.command).slice(0, 5) ?? [],
	};
}
