import { createHash, randomUUID } from "node:crypto";
import {
	type AgentActionInput,
	type AgentActionRecord,
	COMPLIANCE_FRAMEWORKS,
	type ComplianceFramework,
	type ComplianceJsonValue,
	type ComplianceReportRequest,
	type GovernanceEvaluationInput,
	type GovernanceEvaluationRecord,
	type NormalizedComplianceReportRequest,
} from "./types.js";

export class ComplianceValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComplianceValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function cleanRequiredString(value: unknown, label: string): string {
	const trimmed = cleanOptionalString(value);
	if (!trimmed) {
		throw new ComplianceValidationError(`${label} is required.`);
	}
	return trimmed;
}

function parseDate(
	value: Date | string | undefined,
	label: string,
): Date | undefined {
	if (value === undefined) return undefined;
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new ComplianceValidationError(`${label} must be a valid date.`);
	}
	return parsed;
}

export function parseComplianceFramework(value: string): ComplianceFramework {
	const normalized = value.trim().toLowerCase();
	if (COMPLIANCE_FRAMEWORKS.includes(normalized as ComplianceFramework)) {
		return normalized as ComplianceFramework;
	}
	throw new ComplianceValidationError(
		"Invalid compliance framework. Use soc2 or iso27001.",
	);
}

export function parseComplianceFrameworks(
	value: unknown,
): ComplianceFramework[] {
	if (value === undefined || value === null) return ["soc2", "iso27001"];
	if (typeof value === "string") {
		return Array.from(
			new Set(
				value
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean)
					.map(parseComplianceFramework),
			),
		);
	}
	if (!Array.isArray(value)) {
		throw new ComplianceValidationError("frameworks must be an array.");
	}
	const frameworks = Array.from(
		new Set(value.map((entry) => parseComplianceFramework(String(entry)))),
	);
	return frameworks.length > 0 ? frameworks : ["soc2", "iso27001"];
}

function sanitizeJsonValue(
	value: unknown,
	depth = 0,
): ComplianceJsonValue | undefined {
	if (depth > 12) return String(value);
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		return value
			.map((item) => sanitizeJsonValue(item, depth + 1))
			.filter((item): item is ComplianceJsonValue => item !== undefined);
	}
	if (isRecord(value)) {
		const result: Record<string, ComplianceJsonValue> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			const sanitized = sanitizeJsonValue(nestedValue, depth + 1);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

function sanitizeMetadata(
	value: Record<string, unknown> | undefined,
): Record<string, ComplianceJsonValue> {
	if (!value) return {};
	const sanitized = sanitizeJsonValue(value);
	return isRecord(sanitized)
		? (sanitized as Record<string, ComplianceJsonValue>)
		: {};
}

function stableActionId(input: AgentActionInput, timestamp: Date): string {
	const explicit = cleanOptionalString(input.actionId);
	if (explicit) return explicit;
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				workspaceId: input.workspaceId,
				agentId: input.agentId,
				type: input.type,
				resource: input.resource,
				timestamp: timestamp.toISOString(),
			}),
		)
		.digest("hex")
		.slice(0, 16);
	return `action_${digest || randomUUID()}`;
}

function stableGovernanceEvaluationId(
	input: GovernanceEvaluationInput,
	timestamp: Date,
): string {
	const explicit = cleanOptionalString(input.evaluationId);
	if (explicit) return explicit;
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				workspaceId: input.workspaceId,
				agentId: input.agentId,
				policyId: input.policyId,
				actionType: input.actionType,
				decision: input.decision,
				timestamp: timestamp.toISOString(),
			}),
		)
		.digest("hex")
		.slice(0, 16);
	return `governance_${digest || randomUUID()}`;
}

export function normalizeAgentActionInput(
	input: AgentActionInput,
): AgentActionRecord {
	if (!isRecord(input)) {
		throw new ComplianceValidationError("Agent action must be an object.");
	}
	const timestamp =
		parseDate(input.timestamp, "action.timestamp") ?? new Date();
	const type = cleanRequiredString(input.type, "action.type").toLowerCase();
	const workspaceId = cleanOptionalString(input.workspaceId);
	const agentId = cleanOptionalString(input.agentId);
	const resource = cleanOptionalString(input.resource);
	const description = cleanOptionalString(input.description);
	return {
		actionId: stableActionId(input, timestamp),
		type,
		status: cleanOptionalString(input.status)?.toLowerCase() ?? "success",
		timestamp: timestamp.toISOString(),
		metadata: sanitizeMetadata(input.metadata),
		...(workspaceId ? { workspaceId } : {}),
		...(agentId ? { agentId } : {}),
		...(resource ? { resource } : {}),
		...(description ? { description } : {}),
	};
}

export function normalizeGovernanceEvaluationInput(
	input: GovernanceEvaluationInput,
): GovernanceEvaluationRecord {
	if (!isRecord(input)) {
		throw new ComplianceValidationError(
			"Governance evaluation must be an object.",
		);
	}
	const timestamp =
		parseDate(input.timestamp, "governanceEvents[].timestamp") ?? new Date();
	const actionType = cleanRequiredString(
		input.actionType,
		"governanceEvents[].actionType",
	).toLowerCase();
	const decision = cleanRequiredString(
		input.decision,
		"governanceEvents[].decision",
	).toLowerCase();
	const workspaceId = cleanOptionalString(input.workspaceId);
	const agentId = cleanOptionalString(input.agentId);
	const policyId = cleanOptionalString(input.policyId);
	const riskLevel = cleanOptionalString(input.riskLevel)?.toLowerCase();
	const reason = cleanOptionalString(input.reason);
	return {
		evaluationId: stableGovernanceEvaluationId(input, timestamp),
		actionType,
		decision,
		timestamp: timestamp.toISOString(),
		metadata: sanitizeMetadata(input.metadata),
		...(workspaceId ? { workspaceId } : {}),
		...(agentId ? { agentId } : {}),
		...(policyId ? { policyId } : {}),
		...(riskLevel ? { riskLevel } : {}),
		...(reason ? { reason } : {}),
	};
}

export function normalizeComplianceReportRequest(
	input: ComplianceReportRequest,
): NormalizedComplianceReportRequest {
	if (!isRecord(input)) {
		throw new ComplianceValidationError("Report request must be an object.");
	}
	const reportInput = input as ComplianceReportRequest;
	const from = parseDate(reportInput.from, "from");
	const to = parseDate(reportInput.to, "to");
	if (from && to && from.getTime() > to.getTime()) {
		throw new ComplianceValidationError("from must be before or equal to to.");
	}
	const actions = Array.isArray(reportInput.actions)
		? reportInput.actions.map(normalizeAgentActionInput)
		: [];
	const governanceEvents = Array.isArray(reportInput.governanceEvents)
		? reportInput.governanceEvents.map(normalizeGovernanceEvaluationInput)
		: [];
	const workspaceId = cleanOptionalString(reportInput.workspaceId);
	return {
		frameworks: parseComplianceFrameworks(reportInput.frameworks),
		actions,
		governanceEvents,
		includeEvidence: reportInput.includeEvidence !== false,
		includeArtifact: reportInput.includeArtifact !== false,
		...(workspaceId ? { workspaceId } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
	};
}

export function normalizeComplianceEvidenceQuery(input: {
	workspaceId?: unknown;
	from?: unknown;
	to?: unknown;
}): {
	workspaceId?: string;
	from?: Date;
	to?: Date;
} {
	const from = parseDate(
		typeof input.from === "string" || input.from instanceof Date
			? input.from
			: undefined,
		"from",
	);
	const to = parseDate(
		typeof input.to === "string" || input.to instanceof Date
			? input.to
			: undefined,
		"to",
	);
	if (from && to && from.getTime() > to.getTime()) {
		throw new ComplianceValidationError("from must be before or equal to to.");
	}
	const workspaceId = cleanOptionalString(input.workspaceId);
	return {
		...(workspaceId ? { workspaceId } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
	};
}

export function actionWithinPeriod(
	action: AgentActionRecord,
	query: { from?: Date; to?: Date },
): boolean {
	const timestamp = new Date(action.timestamp).getTime();
	if (query.from && timestamp < query.from.getTime()) return false;
	if (query.to && timestamp > query.to.getTime()) return false;
	return true;
}
