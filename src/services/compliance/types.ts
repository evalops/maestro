export const COMPLIANCE_FRAMEWORKS = ["soc2", "iso27001"] as const;

export type ComplianceFramework = (typeof COMPLIANCE_FRAMEWORKS)[number];

export type ComplianceJsonValue =
	| string
	| number
	| boolean
	| null
	| ComplianceJsonValue[]
	| { [key: string]: ComplianceJsonValue };

export interface ComplianceControl {
	id: string;
	framework: ComplianceFramework;
	title: string;
	description: string;
	evidenceTypes: string[];
	mappedActionTypes: string[];
}

export interface AgentActionInput {
	actionId?: string;
	workspaceId?: string;
	agentId?: string;
	type: string;
	status?: string;
	timestamp?: Date | string;
	resource?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface AgentActionRecord {
	actionId: string;
	workspaceId?: string;
	agentId?: string;
	type: string;
	status: string;
	timestamp: string;
	resource?: string;
	description?: string;
	metadata: Record<string, ComplianceJsonValue>;
}

export interface GovernanceEvaluationInput {
	evaluationId?: string;
	workspaceId?: string;
	agentId?: string;
	policyId?: string;
	actionType: string;
	decision: string;
	riskLevel?: string;
	reason?: string;
	timestamp?: Date | string;
	metadata?: Record<string, unknown>;
}

export interface GovernanceEvaluationRecord {
	evaluationId: string;
	workspaceId?: string;
	agentId?: string;
	policyId?: string;
	actionType: string;
	decision: string;
	riskLevel?: string;
	reason?: string;
	timestamp: string;
	metadata: Record<string, ComplianceJsonValue>;
}

export interface ComplianceEvidence {
	evidenceId: string;
	controlId: string;
	framework: ComplianceFramework;
	sourceType: string;
	timestamp: string;
	summary: string;
	workspaceId?: string;
	agentId?: string;
	actionId?: string;
	traceId?: string;
	resource?: string;
	status?: string;
	metadata: Record<string, ComplianceJsonValue>;
}

export interface ComplianceReportRequest {
	workspaceId?: string;
	frameworks?: ComplianceFramework[];
	from?: Date | string;
	to?: Date | string;
	actions?: AgentActionInput[];
	governanceEvents?: GovernanceEvaluationInput[];
	includeEvidence?: boolean;
	includeArtifact?: boolean;
}

export interface NormalizedComplianceReportRequest {
	workspaceId?: string;
	frameworks: ComplianceFramework[];
	from?: Date;
	to?: Date;
	actions: AgentActionRecord[];
	governanceEvents: GovernanceEvaluationRecord[];
	includeEvidence: boolean;
	includeArtifact: boolean;
}

export interface ComplianceControlReport {
	control: ComplianceControl;
	status: "satisfied" | "missing";
	evidenceCount: number;
	evidence?: ComplianceEvidence[];
}

export interface ComplianceArtifactControlMatrixRow {
	controlId: string;
	framework: ComplianceFramework;
	title: string;
	status: "satisfied" | "missing";
	evidenceCount: number;
	evidenceIds: string[];
	evidenceSources: string[];
	lastEvidenceAt?: string;
}

export interface ComplianceArtifactGap {
	controlId: string;
	framework: ComplianceFramework;
	title: string;
	severity: "high" | "medium";
	reason: string;
	remediation: string;
}

export interface ComplianceArtifactSourceManifestEntry {
	sourceType: string;
	evidenceCount: number;
	firstSeenAt?: string;
	lastSeenAt?: string;
}

export interface ComplianceArtifact {
	artifactId: string;
	format: "auditor_json";
	reportId: string;
	generatedAt: string;
	workspaceId?: string;
	period: {
		from?: string;
		to?: string;
	};
	frameworks: ComplianceFramework[];
	executiveSummary: string;
	controlMatrix: ComplianceArtifactControlMatrixRow[];
	evidenceIndex: ComplianceEvidence[];
	gaps: ComplianceArtifactGap[];
	sourceManifest: ComplianceArtifactSourceManifestEntry[];
	exports: {
		drata: {
			controlEvidence: Array<{
				controlExternalId: string;
				evidenceIds: string[];
				status: "ready" | "gap";
			}>;
		};
		vanta: {
			customEvidence: Array<{
				controlId: string;
				title: string;
				evidenceCount: number;
			}>;
		};
	};
}

export interface ComplianceReport {
	reportId: string;
	generatedAt: string;
	workspaceId?: string;
	period: {
		from?: string;
		to?: string;
	};
	frameworks: ComplianceFramework[];
	summary: {
		controls: number;
		satisfied: number;
		missing: number;
		evidenceItems: number;
	};
	controls: ComplianceControlReport[];
	artifact?: ComplianceArtifact;
}

export interface ComplianceEvidenceQuery {
	workspaceId?: string;
	from?: Date;
	to?: Date;
}

export interface ComplianceControlEvidence {
	control: ComplianceControl;
	evidence: ComplianceEvidence[];
}
