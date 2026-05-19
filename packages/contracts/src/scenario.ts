export const MAESTRO_SCENARIO_SCHEMA = "evalops.maestro.scenario.v1" as const;
export const MAESTRO_SCRIPTED_SCENARIO_SCHEMA =
	"evalops.maestro.scripted-scenario.v1" as const;

export type MaestroScenarioOutcome = "pass" | "fail";

export type MaestroScenarioSeverity = "error" | "warning";

export type MaestroScenarioReviewLabel =
	| "accepted"
	| "needs_human_review"
	| "unsafe_input"
	| "efficiency_regression"
	| "platform_promotion_ready"
	| "degraded";

export interface MaestroScenarioSource {
	trajectoryPath: string;
	replayPath: string;
	scorePath: string;
	inspectionPath?: string;
	baselineTrajectoryPath?: string;
	candidateTrajectoryPath?: string;
	baselineScorePath?: string;
	candidateScorePath?: string;
}

export interface MaestroScenarioPlatformLink {
	primitive:
		| "timeline"
		| "trajectory"
		| "event_bus"
		| "artifact_store"
		| "standalone";
	eventType?: string;
	traceJoinKeys: string[];
	rationale?: string;
}

export interface MaestroScenarioExternalRefs {
	ensembleTranscriptIds?: string[];
	platformTraceIds?: string[];
	platformWorkEnvelopeIds?: string[];
	slackThreadRefs?: string[];
	evidenceArtifactIds?: string[];
}

export interface MaestroScenarioAssertion {
	id: string;
	kind:
		| "event.exists"
		| "event.forbidden"
		| "replay.deltas"
		| "score.finding"
		| "inspection.redaction"
		| "efficiency.budget"
		| "provenance.chain"
		| "human.review"
		| "external.refs"
		| "trajectory.diff";
	severity?: MaestroScenarioSeverity;
	selector?: {
		kind?: string;
		phase?: string;
		type?: string;
		status?: string;
		toolName?: string;
		source?: string;
		actor?: string;
	};
	ruleId?: string;
	status?: "pass" | "fail" | "warn";
	forbiddenTerms?: string[];
	maxEvents?: number;
	maxToolCalls?: number;
	maxReplayDeltas?: number;
	maxReplayErrors?: number;
	maxScoreFailures?: number;
	maxScoreWarnings?: number;
	maxAddedEvents?: number;
	maxAddedToolCalls?: number;
	maxAddedScoreFailures?: number;
	eventId?: string;
	requiredEvidenceKinds?: string[];
	requiredLabels?: MaestroScenarioReviewLabel[];
	requiredExternalRefKinds?: (keyof MaestroScenarioExternalRefs)[];
	requiredExternalRefs?: string[];
	note?: string;
}

export interface MaestroScenario {
	schemaVersion: typeof MAESTRO_SCENARIO_SCHEMA;
	id: string;
	title: string;
	description: string;
	expectedOutcome?: MaestroScenarioOutcome;
	source: MaestroScenarioSource;
	reviewLabels: MaestroScenarioReviewLabel[];
	platform: MaestroScenarioPlatformLink;
	externalRefs?: MaestroScenarioExternalRefs;
	assumptions: {
		workflow: string;
		correctnessModel: string;
		threatModel: string;
		researchBasis: string[];
	};
	assertions: MaestroScenarioAssertion[];
}

export type MaestroScriptedScenarioEndReason =
	| "complete"
	| "aborted"
	| "limit_exceeded";

export type MaestroScriptedStatement =
	| { kind: "text"; text: string; streamMs?: number }
	| { kind: "delay"; ms: number }
	| {
			kind: "tool_call";
			tool: string;
			input?: unknown;
			id?: string;
			expectedResult?: "success" | "error" | "any";
	  }
	| { kind: "error"; type: "transient" | "fatal"; message: string }
	| { kind: "wait_for_user" }
	| { kind: "end"; reason: MaestroScriptedScenarioEndReason };

export interface MaestroScriptedScenarioFrame {
	index: number;
	statements: MaestroScriptedStatement[];
}

export type MaestroScriptedScenarioAssertionKind =
	| "tool_called"
	| "tool_not_called"
	| "file_exists"
	| "file_contents"
	| "audit_event_emitted";

export interface MaestroScriptedScenarioAssertion {
	id: string;
	kind: MaestroScriptedScenarioAssertionKind;
	severity?: MaestroScenarioSeverity;
	tool?: string;
	toolCallId?: string;
	path?: string;
	contains?: string;
	equals?: string;
	eventType?: string;
	note?: string;
}

export interface MaestroScriptedScenario {
	schemaVersion: typeof MAESTRO_SCRIPTED_SCENARIO_SCHEMA;
	id: string;
	description: string;
	expectedOutcome?: MaestroScenarioOutcome;
	metadata: {
		recordedFrom?: string;
		recordedAt: string;
		modelOriginal?: string;
		toolsExpected: string[];
		auditEvents?: string[];
	};
	frames: MaestroScriptedScenarioFrame[];
	assertions?: MaestroScriptedScenarioAssertion[];
}
