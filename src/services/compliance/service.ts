import { createHash } from "node:crypto";
import {
	type ExecutionTraceSummary,
	type TraceListQuery,
	type TracesService,
	TracesUnavailableError,
	getTracesService,
} from "../traces/index.js";
import {
	controlIdsForActionType,
	getComplianceControl,
	listComplianceControls,
} from "./controls.js";
import {
	actionWithinPeriod,
	normalizeAgentActionInput,
	normalizeComplianceReportRequest,
	normalizeGovernanceEvaluationInput,
} from "./normalize.js";
import type {
	AgentActionInput,
	AgentActionRecord,
	ComplianceArtifact,
	ComplianceArtifactControlMatrixRow,
	ComplianceArtifactGap,
	ComplianceArtifactSourceManifestEntry,
	ComplianceControl,
	ComplianceControlEvidence,
	ComplianceControlReport,
	ComplianceEvidence,
	ComplianceEvidenceQuery,
	ComplianceFramework,
	ComplianceJsonValue,
	ComplianceReport,
	ComplianceReportRequest,
	GovernanceEvaluationInput,
	GovernanceEvaluationRecord,
	NormalizedComplianceReportRequest,
} from "./types.js";

const MAX_TRACKED_ACTIONS = 5_000;
const TRACE_EVIDENCE_LIMIT = 100;

type TraceServiceProvider = () => Pick<TracesService, "listTraces">;

function hashId(prefix: string, payload: unknown): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(payload))
		.digest("hex")
		.slice(0, 16);
	return `${prefix}_${digest}`;
}

function reportPeriod(request: NormalizedComplianceReportRequest) {
	return {
		...(request.from ? { from: request.from.toISOString() } : {}),
		...(request.to ? { to: request.to.toISOString() } : {}),
	};
}

function evidenceTimestampInRange(
	timestamp: string,
	query: ComplianceEvidenceQuery,
): boolean {
	const value = Date.parse(timestamp);
	if (Number.isNaN(value)) return false;
	if (query.from && value < query.from.getTime()) return false;
	if (query.to && value > query.to.getTime()) return false;
	return true;
}

function actionMatchesWorkspace(
	action: AgentActionRecord,
	workspaceId?: string,
): boolean {
	return !workspaceId || action.workspaceId === workspaceId;
}

function evidenceMatchesWorkspace(
	evidence: ComplianceEvidence,
	workspaceId?: string,
): boolean {
	return !workspaceId || evidence.workspaceId === workspaceId;
}

function governanceEventMatchesWorkspace(
	event: GovernanceEvaluationRecord,
	workspaceId?: string,
): boolean {
	return !workspaceId || event.workspaceId === workspaceId;
}

function decisionToActionStatus(decision: string): string {
	switch (decision) {
		case "allow":
		case "allowed":
		case "approve":
		case "approved":
		case "success":
			return "success";
		case "deny":
		case "denied":
		case "block":
		case "blocked":
		case "reject":
		case "rejected":
			return "denied";
		case "escalate":
		case "escalated":
		case "review":
		case "needs_review":
			return "needs_review";
		default:
			return decision;
	}
}

function actionForGovernanceEvent(
	event: GovernanceEvaluationRecord,
): AgentActionRecord {
	const metadata: Record<string, ComplianceJsonValue> = {
		...event.metadata,
		source: "governance",
		governanceEvaluationId: event.evaluationId,
		actionType: event.actionType,
		decision: event.decision,
		...(event.policyId ? { policyId: event.policyId } : {}),
		...(event.riskLevel ? { riskLevel: event.riskLevel } : {}),
		...(event.reason ? { reason: event.reason } : {}),
	};
	return {
		actionId: event.evaluationId,
		type: "policy_evaluation",
		status: decisionToActionStatus(event.decision),
		timestamp: event.timestamp,
		resource: event.policyId ?? event.actionType,
		description: event.policyId
			? `Governance policy ${event.policyId} ${event.decision} for ${event.actionType}`
			: `Governance evaluation ${event.decision} for ${event.actionType}`,
		metadata,
		...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
		...(event.agentId ? { agentId: event.agentId } : {}),
	};
}

function sourceTypeForAction(action: AgentActionRecord): string {
	if (action.type === "trace_recorded") {
		return "execution_trace";
	}
	if (
		action.type === "policy_evaluation" &&
		action.metadata.source === "governance"
	) {
		return "governance_policy_evaluation";
	}
	return action.type;
}

function evidenceForAction(
	action: AgentActionRecord,
	control: ComplianceControl,
): ComplianceEvidence {
	const summary = action.description
		? `${control.title}: ${action.description}`
		: `${control.title}: ${action.type} ${action.status}`;
	const metadata: Record<string, ComplianceJsonValue> = {
		actionType: action.type,
		...action.metadata,
	};
	return {
		evidenceId: hashId("evidence", {
			controlId: control.id,
			actionId: action.actionId,
		}),
		controlId: control.id,
		framework: control.framework,
		sourceType: sourceTypeForAction(action),
		timestamp: action.timestamp,
		summary,
		actionId: action.actionId,
		status: action.status,
		metadata,
		...(action.workspaceId ? { workspaceId: action.workspaceId } : {}),
		...(action.agentId ? { agentId: action.agentId } : {}),
		...(action.resource ? { resource: action.resource } : {}),
	};
}

function evidenceForTrace(
	trace: ExecutionTraceSummary,
	control: ComplianceControl,
): ComplianceEvidence {
	return {
		evidenceId: hashId("evidence", {
			controlId: control.id,
			traceId: trace.traceId,
		}),
		controlId: control.id,
		framework: control.framework,
		sourceType: "execution_trace",
		timestamp: trace.createdAt,
		summary: `${control.title}: execution trace ${trace.traceId} recorded with ${trace.status} status`,
		workspaceId: trace.workspaceId,
		agentId: trace.agentId,
		traceId: trace.traceId,
		status: trace.status,
		metadata: {
			durationMs: trace.durationMs,
			spanCount: trace.spanCount,
		},
	};
}

function compareEvidence(a: ComplianceEvidence, b: ComplianceEvidence): number {
	const byTime = Date.parse(b.timestamp) - Date.parse(a.timestamp);
	if (byTime !== 0) return byTime;
	return a.evidenceId.localeCompare(b.evidenceId);
}

function dedupeEvidence(evidence: ComplianceEvidence[]): ComplianceEvidence[] {
	const byId = new Map<string, ComplianceEvidence>();
	for (const item of evidence) {
		byId.set(item.evidenceId, item);
	}
	return Array.from(byId.values()).sort(compareEvidence);
}

function sourceManifest(
	evidence: ComplianceEvidence[],
): ComplianceArtifactSourceManifestEntry[] {
	const bySource = new Map<
		string,
		{ count: number; firstSeenAt?: string; lastSeenAt?: string }
	>();
	for (const item of evidence) {
		const current = bySource.get(item.sourceType) ?? { count: 0 };
		current.count += 1;
		if (!current.firstSeenAt || item.timestamp < current.firstSeenAt) {
			current.firstSeenAt = item.timestamp;
		}
		if (!current.lastSeenAt || item.timestamp > current.lastSeenAt) {
			current.lastSeenAt = item.timestamp;
		}
		bySource.set(item.sourceType, current);
	}
	return Array.from(bySource.entries())
		.map(([sourceType, entry]) => ({
			sourceType,
			evidenceCount: entry.count,
			...(entry.firstSeenAt ? { firstSeenAt: entry.firstSeenAt } : {}),
			...(entry.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
		}))
		.sort((a, b) => a.sourceType.localeCompare(b.sourceType));
}

function controlMatrixRows(
	controls: ComplianceControlReport[],
	evidence: ComplianceEvidence[],
): ComplianceArtifactControlMatrixRow[] {
	return controls.map((entry) => {
		const controlEvidence = evidence.filter(
			(item) => item.controlId === entry.control.id,
		);
		const sourceTypes = Array.from(
			new Set(controlEvidence.map((item) => item.sourceType)),
		).sort();
		const latest = controlEvidence
			.map((item) => item.timestamp)
			.sort()
			.at(-1);
		return {
			controlId: entry.control.id,
			framework: entry.control.framework,
			title: entry.control.title,
			status: entry.status,
			evidenceCount: controlEvidence.length,
			evidenceIds: controlEvidence.map((item) => item.evidenceId),
			evidenceSources: sourceTypes,
			...(latest ? { lastEvidenceAt: latest } : {}),
		};
	});
}

function gapSeverity(
	control: ComplianceControl,
): ComplianceArtifactGap["severity"] {
	return control.evidenceTypes.some(
		(type) => type.includes("access") || type === "approval",
	)
		? "high"
		: "medium";
}

function artifactGaps(
	controls: ComplianceControlReport[],
): ComplianceArtifactGap[] {
	return controls
		.filter((entry) => entry.status === "missing")
		.map((entry) => ({
			controlId: entry.control.id,
			framework: entry.control.framework,
			title: entry.control.title,
			severity: gapSeverity(entry.control),
			reason: `No evidence found for expected sources: ${entry.control.evidenceTypes.join(", ")}.`,
			remediation:
				"Connect governance, approvals, trace, audit, or identity events that satisfy this control for the requested period.",
		}));
}

function executiveSummary(report: ComplianceReport): string {
	const frameworkList = report.frameworks.join(", ").toUpperCase();
	return `${report.summary.satisfied} of ${report.summary.controls} ${frameworkList} controls are satisfied with ${report.summary.evidenceItems} evidence item(s); ${report.summary.missing} control(s) need additional evidence.`;
}

function renderComplianceArtifact(
	report: ComplianceReport,
	evidence: ComplianceEvidence[],
	controls: ComplianceControlReport[],
): ComplianceArtifact {
	const matrix = controlMatrixRows(controls, evidence);
	return {
		artifactId: hashId("compliance_artifact", {
			reportId: report.reportId,
			evidenceIds: evidence.map((item) => item.evidenceId),
		}),
		format: "auditor_json",
		reportId: report.reportId,
		generatedAt: report.generatedAt,
		period: report.period,
		frameworks: report.frameworks,
		executiveSummary: executiveSummary(report),
		controlMatrix: matrix,
		evidenceIndex: evidence,
		gaps: artifactGaps(controls),
		sourceManifest: sourceManifest(evidence),
		exports: {
			drata: {
				controlEvidence: matrix.map((row) => ({
					controlExternalId: row.controlId,
					evidenceIds: row.evidenceIds,
					status: row.status === "satisfied" ? "ready" : "gap",
				})),
			},
			vanta: {
				customEvidence: matrix.map((row) => ({
					controlId: row.controlId,
					title: row.title,
					evidenceCount: row.evidenceCount,
				})),
			},
		},
		...(report.workspaceId ? { workspaceId: report.workspaceId } : {}),
	};
}

export class ComplianceService {
	private readonly trackedActions: AgentActionRecord[] = [];
	private readonly trackedGovernanceEvents: GovernanceEvaluationRecord[] = [];

	constructor(
		private readonly getTraceService: TraceServiceProvider = getTracesService,
		private readonly now: () => Date = () => new Date(),
	) {}

	trackAgentAction(input: AgentActionInput): AgentActionRecord {
		const action = normalizeAgentActionInput(input);
		this.trackedActions.push(action);
		if (this.trackedActions.length > MAX_TRACKED_ACTIONS) {
			this.trackedActions.splice(
				0,
				this.trackedActions.length - MAX_TRACKED_ACTIONS,
			);
		}
		return action;
	}

	trackGovernanceEvaluation(
		input: GovernanceEvaluationInput,
	): GovernanceEvaluationRecord {
		const event = normalizeGovernanceEvaluationInput(input);
		this.trackedGovernanceEvents.push(event);
		if (this.trackedGovernanceEvents.length > MAX_TRACKED_ACTIONS) {
			this.trackedGovernanceEvents.splice(
				0,
				this.trackedGovernanceEvents.length - MAX_TRACKED_ACTIONS,
			);
		}
		return event;
	}

	listControls(frameworks?: ComplianceFramework[]): ComplianceControl[] {
		return listComplianceControls(frameworks);
	}

	async generateReport(
		input: ComplianceReportRequest,
	): Promise<ComplianceReport> {
		const request = normalizeComplianceReportRequest(input);
		const controls = listComplianceControls(request.frameworks);
		const evidence = await this.collectEvidence(request, controls);
		const controlsWithEvidence = controls.map((control) => {
			const controlEvidence = evidence.filter(
				(item) => item.controlId === control.id,
			);
			return {
				control,
				status: controlEvidence.length > 0 ? "satisfied" : "missing",
				evidenceCount: controlEvidence.length,
				...(request.includeEvidence ? { evidence: controlEvidence } : {}),
			} as const;
		});
		const satisfied = controlsWithEvidence.filter(
			(control) => control.status === "satisfied",
		).length;
		const generatedAt = this.now().toISOString();
		const report: ComplianceReport = {
			reportId: hashId("compliance_report", {
				generatedAt,
				workspaceId: request.workspaceId,
				frameworks: request.frameworks,
				period: reportPeriod(request),
				evidenceIds: evidence.map((item) => item.evidenceId),
			}),
			generatedAt,
			period: reportPeriod(request),
			frameworks: request.frameworks,
			summary: {
				controls: controls.length,
				satisfied,
				missing: controls.length - satisfied,
				evidenceItems: evidence.length,
			},
			controls: controlsWithEvidence,
			...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
		};
		if (request.includeArtifact) {
			report.artifact = renderComplianceArtifact(
				report,
				evidence,
				controlsWithEvidence,
			);
		}
		return report;
	}

	async getEvidenceForControl(
		controlId: string,
		query: ComplianceEvidenceQuery,
	): Promise<ComplianceControlEvidence | null> {
		const control = getComplianceControl(controlId);
		if (!control) return null;
		const request: NormalizedComplianceReportRequest = {
			frameworks: [control.framework],
			actions: [],
			governanceEvents: [],
			includeEvidence: true,
			includeArtifact: false,
			...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
			...(query.from ? { from: query.from } : {}),
			...(query.to ? { to: query.to } : {}),
		};
		const evidence = (await this.collectEvidence(request, [control])).filter(
			(item) => item.controlId === control.id,
		);
		return { control, evidence };
	}

	clearTrackedActionsForTest(): void {
		this.trackedActions.length = 0;
		this.trackedGovernanceEvents.length = 0;
	}

	private trackedActionsForRequest(
		request: NormalizedComplianceReportRequest,
	): AgentActionRecord[] {
		const governanceActions = [
			...this.trackedGovernanceEvents,
			...request.governanceEvents,
		]
			.filter((event) =>
				governanceEventMatchesWorkspace(event, request.workspaceId),
			)
			.filter((event) => evidenceTimestampInRange(event.timestamp, request))
			.map(actionForGovernanceEvent);
		const actions = [
			...this.trackedActions,
			...request.actions,
			...governanceActions,
		];
		const byId = new Map<string, AgentActionRecord>();
		for (const action of actions) {
			if (!actionMatchesWorkspace(action, request.workspaceId)) continue;
			if (!actionWithinPeriod(action, request)) continue;
			byId.set(action.actionId, action);
		}
		return Array.from(byId.values());
	}

	private evidenceFromActions(
		request: NormalizedComplianceReportRequest,
		controls: ComplianceControl[],
	): ComplianceEvidence[] {
		const controlsById = new Map(
			controls.map((control) => [control.id, control]),
		);
		const evidence: ComplianceEvidence[] = [];
		for (const action of this.trackedActionsForRequest(request)) {
			for (const controlId of controlIdsForActionType(action.type)) {
				const control = controlsById.get(controlId);
				if (!control) continue;
				evidence.push(evidenceForAction(action, control));
			}
		}
		return evidence;
	}

	private async evidenceFromTraces(
		request: NormalizedComplianceReportRequest,
		controls: ComplianceControl[],
	): Promise<ComplianceEvidence[]> {
		const traceControls = controls.filter((control) =>
			control.mappedActionTypes.includes("trace_recorded"),
		);
		if (traceControls.length === 0) return [];

		const query: TraceListQuery = {
			limit: TRACE_EVIDENCE_LIMIT,
			offset: 0,
		};
		if (request.workspaceId) {
			query.workspaceId = request.workspaceId;
		}

		try {
			const result = await this.getTraceService().listTraces(query);
			const evidence: ComplianceEvidence[] = [];
			for (const trace of result.traces) {
				if (!evidenceTimestampInRange(trace.createdAt, request)) continue;
				for (const control of traceControls) {
					evidence.push(evidenceForTrace(trace, control));
				}
			}
			return evidence;
		} catch (error) {
			if (error instanceof TracesUnavailableError) {
				return [];
			}
			throw error;
		}
	}

	private async collectEvidence(
		request: NormalizedComplianceReportRequest,
		controls: ComplianceControl[],
	): Promise<ComplianceEvidence[]> {
		const evidence = [
			...this.evidenceFromActions(request, controls),
			...(await this.evidenceFromTraces(request, controls)),
		].filter((item) => evidenceMatchesWorkspace(item, request.workspaceId));
		return dedupeEvidence(evidence);
	}
}

let defaultComplianceService: ComplianceService | null = null;

export function getComplianceService(): ComplianceService {
	defaultComplianceService ??= new ComplianceService();
	return defaultComplianceService;
}

export function setComplianceServiceForTest(
	service: ComplianceService | null,
): void {
	defaultComplianceService = service;
}
