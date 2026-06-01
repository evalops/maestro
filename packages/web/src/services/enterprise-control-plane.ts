import type {
	Alert,
	AuditLog,
	DirectoryRule,
	ModelApproval,
	OrgUsageSummary,
	OrganizationSettings,
	UsageQuota,
} from "./enterprise-api.js";

export type ControlPlaneTone = "success" | "warning" | "error" | "info";

export interface EnterpriseControlMetric {
	label: string;
	value: string;
	tone: ControlPlaneTone;
	detail: string;
}

export interface EnterpriseControlLane {
	name: string;
	source: string;
	control: string;
	status: string;
	tone: ControlPlaneTone;
	evidence: string;
	nextAction: string;
}

export interface EnterpriseWatchItem {
	id: string;
	label: string;
	source: string;
	severity: ControlPlaneTone;
	detail: string;
	createdAt?: string;
}

export interface EnterpriseControlPlaneSummary {
	posture: {
		label: string;
		tone: ControlPlaneTone;
		detail: string;
	};
	metrics: EnterpriseControlMetric[];
	lanes: EnterpriseControlLane[];
	watchItems: EnterpriseWatchItem[];
}

export interface EnterpriseControlPlaneInput {
	usage: OrgUsageSummary | null;
	quota: UsageQuota | null;
	alerts: Alert[];
	auditLogs: AuditLog[];
	modelApprovals: ModelApproval[];
	directoryRules: DirectoryRule[];
	orgSettings: OrganizationSettings | null;
}

export function buildEnterpriseControlPlaneSummary(
	input: EnterpriseControlPlaneInput,
): EnterpriseControlPlaneSummary {
	const unresolvedAlerts = input.alerts.filter((alert) => !alert.resolvedAt);
	const highRiskAlerts = unresolvedAlerts.filter(
		(alert) => alert.severity === "critical" || alert.severity === "high",
	);
	const pendingModels = input.modelApprovals.filter(
		(approval) => approval.status === "pending",
	);
	const deniedModels = input.modelApprovals.filter(
		(approval) => approval.status === "denied",
	);
	const approvedModels = input.modelApprovals.filter(
		(approval) =>
			approval.status === "approved" || approval.status === "auto_approved",
	);
	const deniedAuditLogs = input.auditLogs.filter((log) =>
		["denied", "failure", "error"].includes(log.status),
	);
	const denyRules = input.directoryRules.filter((rule) => !rule.isAllowed);
	const allowRules = input.directoryRules.filter((rule) => rule.isAllowed);
	const webhookCount =
		input.orgSettings?.alertWebhooks?.filter(Boolean).length ?? 0;
	const piiEnabled = input.orgSettings?.piiRedactionEnabled === true;
	const quotaPressure = getQuotaPressure(input.quota);

	const blockerCount =
		highRiskAlerts.length +
		pendingModels.length +
		(quotaPressure === "error" ? 1 : 0);
	const posture =
		blockerCount > 0
			? {
					label: "Needs operator review",
					tone: "warning" as const,
					detail: `${blockerCount} enterprise control ${blockerCount === 1 ? "signal" : "signals"} need attention.`,
				}
			: deniedAuditLogs.length > 0
				? {
						label: "Guardrails active",
						tone: "info" as const,
						detail: `${deniedAuditLogs.length} denied or failed audit events are preserved for review.`,
					}
				: {
						label: "Ready",
						tone: "success" as const,
						detail: "Core enterprise controls are configured and quiet.",
					};

	return {
		posture,
		metrics: [
			{
				label: "Governed Users",
				value: String(input.usage?.totalUsers ?? 0),
				tone: "info",
				detail: `${input.usage?.totalSessions ?? 0} sessions under organization policy`,
			},
			{
				label: "Open Controls",
				value: String(unresolvedAlerts.length + pendingModels.length),
				tone:
					unresolvedAlerts.length + pendingModels.length > 0
						? "warning"
						: "success",
				detail: `${unresolvedAlerts.length} alerts, ${pendingModels.length} model approvals`,
			},
			{
				label: "Policy Boundaries",
				value: String(input.directoryRules.length),
				tone: input.directoryRules.length > 0 ? "success" : "warning",
				detail: `${allowRules.length} allow rules, ${denyRules.length} deny rules`,
			},
			{
				label: "Audit Evidence",
				value: String(input.auditLogs.length),
				tone: input.auditLogs.length > 0 ? "success" : "warning",
				detail: `${deniedAuditLogs.length} denied, failed, or errored events`,
			},
		],
		lanes: [
			{
				name: "Runtime Fleet",
				source: "Fleet dashboard",
				control: "Agent health, task pressure, approval queues",
				status: input.usage?.totalSessions ? "Observed" : "Awaiting runs",
				tone: input.usage?.totalSessions ? "success" : "info",
				evidence: `${input.usage?.totalSessions ?? 0} sessions tracked`,
				nextAction: "Use fleet detail for per-agent remediation.",
			},
			{
				name: "Model Governance",
				source: "Model approvals",
				control: "Provider allowlist, spend ceilings, role scoping",
				status: pendingModels.length > 0 ? "Approval backlog" : "In policy",
				tone: pendingModels.length > 0 ? "warning" : "success",
				evidence: `${approvedModels.length} approved, ${pendingModels.length} pending, ${deniedModels.length} denied`,
				nextAction:
					pendingModels.length > 0
						? "Review pending model requests."
						: "Keep provider coverage current.",
			},
			{
				name: "Data Boundaries",
				source: "Directory rules and PII settings",
				control: "Workspace allow/deny rules, PII redaction",
				status:
					input.directoryRules.length === 0 || !piiEnabled
						? "Coverage gap"
						: "Bounded",
				tone:
					input.directoryRules.length === 0 || !piiEnabled
						? "warning"
						: "success",
				evidence: `${input.directoryRules.length} directory rules, PII ${piiEnabled ? "enabled" : "off"}`,
				nextAction:
					input.directoryRules.length === 0
						? "Add directory rules for sensitive workspaces."
						: "Review sensitive-data coverage.",
			},
			{
				name: "Audit and SIEM",
				source: "Audit logs and alert webhooks",
				control: "Exportable audit trail, alert delivery",
				status: webhookCount > 0 ? "Routed" : "Local only",
				tone: webhookCount > 0 ? "success" : "warning",
				evidence: `${input.auditLogs.length} logs, ${webhookCount} webhooks`,
				nextAction:
					webhookCount > 0
						? "Validate downstream delivery."
						: "Configure alert webhooks for enterprise monitoring.",
			},
			{
				name: "Quota and Cost",
				source: "Usage quota",
				control: "Token and spend guardrails",
				status: quotaStatusLabel(quotaPressure, input.quota),
				tone: quotaPressure,
				evidence: quotaEvidence(input.quota),
				nextAction:
					quotaPressure === "error"
						? "Raise limits or reduce usage immediately."
						: "Watch high-growth users and models.",
			},
		],
		watchItems: buildWatchItems({
			alerts: unresolvedAlerts,
			pendingModels,
			deniedAuditLogs,
			quota: input.quota,
			quotaPressure,
			piiEnabled,
			hasDirectoryRules: input.directoryRules.length > 0,
		}),
	};
}

function getQuotaPressure(quota: UsageQuota | null): ControlPlaneTone {
	if (!quota) return "warning";
	return maxPressure(
		getLimitPressure(quota.tokenUsed, quota.tokenQuota),
		getLimitPressure(quota.spendUsed, quota.spendLimit),
	);
}

function getLimitPressure(
	used: number,
	limit: number | null | undefined,
): ControlPlaneTone {
	if (limit == null) return "info";
	if (limit <= 0) return used > 0 ? "error" : "success";
	const percent = used / limit;
	if (percent >= 1) return "error";
	if (percent >= 0.8) return "warning";
	return "success";
}

function maxPressure(...tones: ControlPlaneTone[]): ControlPlaneTone {
	const rank: Record<ControlPlaneTone, number> = {
		info: 0,
		success: 1,
		warning: 2,
		error: 3,
	};
	return tones.reduce((highest, tone) =>
		rank[tone] > rank[highest] ? tone : highest,
	);
}

function quotaStatusLabel(
	tone: ControlPlaneTone,
	quota?: UsageQuota | null,
): string {
	if (!quota) return "Unavailable";
	switch (tone) {
		case "error":
			return "Exceeded";
		case "warning":
			return "Near limit";
		case "success":
			return "Within limit";
		default:
			return "Unlimited";
	}
}

function quotaEvidence(quota: UsageQuota | null): string {
	if (!quota) return "No quota snapshot loaded";
	const tokenEvidence =
		quota.tokenQuota != null
			? `${quota.tokenUsed} of ${quota.tokenQuota} tokens used`
			: `${quota.tokenUsed} tokens used, no token cap`;
	const spendEvidence =
		quota.spendLimit != null
			? `${formatCents(quota.spendUsed)} of ${formatCents(quota.spendLimit)} spend used`
			: `${formatCents(quota.spendUsed)} spend used, no spend cap`;
	return `${tokenEvidence}; ${spendEvidence}`;
}

function formatCents(cents: number): string {
	return (cents / 100).toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function buildWatchItems(input: {
	alerts: Alert[];
	pendingModels: ModelApproval[];
	deniedAuditLogs: AuditLog[];
	quota: UsageQuota | null;
	quotaPressure: ControlPlaneTone;
	piiEnabled: boolean;
	hasDirectoryRules: boolean;
}): EnterpriseWatchItem[] {
	const alertItems = input.alerts.slice(0, 3).map((alert) => ({
		id: `alert-${alert.id}`,
		label: alert.type,
		source: "Alert",
		severity: alertSeverityTone(alert.severity),
		detail: alert.message,
		createdAt: alert.createdAt,
	}));
	const modelItems = input.pendingModels.slice(0, 3).map((approval) => ({
		id: `model-${approval.id}`,
		label: approval.modelId,
		source: "Model approval",
		severity: "warning" as const,
		detail: `${approval.provider} request is waiting for approval`,
	}));
	const auditItems = input.deniedAuditLogs.slice(0, 3).map((log) => ({
		id: `audit-${log.id}`,
		label: log.action,
		source: "Audit",
		severity:
			log.status === "denied" ? ("warning" as const) : ("error" as const),
		detail: `${log.resourceType ?? "resource"} ${log.status}`,
		createdAt: log.createdAt,
	}));
	const coverageItems: EnterpriseWatchItem[] = [];

	if (input.quotaPressure === "error" || input.quotaPressure === "warning") {
		coverageItems.push({
			id: "quota-pressure",
			label: "Quota pressure",
			source: "Usage quota",
			severity: input.quotaPressure,
			detail: quotaEvidence(input.quota),
		});
	}
	if (!input.hasDirectoryRules) {
		coverageItems.push({
			id: "directory-coverage",
			label: "Directory rules missing",
			source: "Directory policy",
			severity: "warning",
			detail: "Workspace access is not bounded by explicit allow or deny rules",
		});
	}
	if (!input.piiEnabled) {
		coverageItems.push({
			id: "pii-coverage",
			label: "PII redaction off",
			source: "Security settings",
			severity: "warning",
			detail: "Sensitive-data redaction is not enabled for enterprise sessions",
		});
	}

	return [...coverageItems, ...alertItems, ...modelItems, ...auditItems].slice(
		0,
		8,
	);
}

function alertSeverityTone(severity: Alert["severity"]): ControlPlaneTone {
	switch (severity) {
		case "critical":
		case "high":
			return "error";
		case "medium":
			return "warning";
		case "low":
		case "info":
			return "info";
		default:
			return "success";
	}
}
