import type { ComplianceControl, ComplianceFramework } from "./types.js";

export const COMPLIANCE_CONTROLS: ComplianceControl[] = [
	{
		id: "soc2.cc6.1",
		framework: "soc2",
		title: "Logical access controls",
		description:
			"Agent access to systems and credentials is authenticated, authorized, and scoped to approved operations.",
		evidenceTypes: ["agent_action", "approval", "access_event"],
		mappedActionTypes: [
			"authentication",
			"authorization",
			"access_grant",
			"credential_access",
			"approval",
		],
	},
	{
		id: "soc2.cc7.2",
		framework: "soc2",
		title: "System monitoring",
		description:
			"Agent executions, tool calls, and policy evaluations are monitored with traceable operational evidence.",
		evidenceTypes: ["execution_trace", "tool_call", "policy_evaluation"],
		mappedActionTypes: [
			"trace_recorded",
			"tool_call",
			"llm_inference",
			"policy_evaluation",
			"safety_check",
		],
	},
	{
		id: "soc2.cc8.1",
		framework: "soc2",
		title: "Change management",
		description:
			"Agent-driven code and configuration changes are traceable to sessions, tools, and review workflow evidence.",
		evidenceTypes: ["file_change", "pull_request", "git_event"],
		mappedActionTypes: [
			"file_change",
			"git_commit",
			"pull_request",
			"deployment",
		],
	},
	{
		id: "iso27001.a.5.15",
		framework: "iso27001",
		title: "Access control",
		description:
			"Access to information and systems is constrained by policy, identity, and authorization decisions.",
		evidenceTypes: ["agent_action", "authorization", "approval"],
		mappedActionTypes: [
			"authentication",
			"authorization",
			"access_grant",
			"credential_access",
			"approval",
		],
	},
	{
		id: "iso27001.a.8.15",
		framework: "iso27001",
		title: "Logging",
		description:
			"Agent execution logs and traces are available for investigation and compliance review.",
		evidenceTypes: ["execution_trace", "audit_event", "tool_call"],
		mappedActionTypes: [
			"trace_recorded",
			"tool_call",
			"llm_inference",
			"policy_evaluation",
		],
	},
	{
		id: "iso27001.a.8.16",
		framework: "iso27001",
		title: "Monitoring activities",
		description:
			"Operational agent activity is monitored for failures, denied actions, and governance outcomes.",
		evidenceTypes: ["execution_trace", "monitoring_event", "safety_check"],
		mappedActionTypes: [
			"trace_recorded",
			"tool_call",
			"policy_evaluation",
			"safety_check",
			"approval",
		],
	},
	{
		id: "iso27001.a.8.32",
		framework: "iso27001",
		title: "Change management",
		description:
			"Changes to software, configuration, and deployment state are controlled and reviewable.",
		evidenceTypes: ["file_change", "pull_request", "deployment"],
		mappedActionTypes: [
			"file_change",
			"git_commit",
			"pull_request",
			"deployment",
		],
	},
];

export function listComplianceControls(
	frameworks?: ComplianceFramework[],
): ComplianceControl[] {
	if (!frameworks || frameworks.length === 0) {
		return COMPLIANCE_CONTROLS;
	}
	const allowed = new Set(frameworks);
	return COMPLIANCE_CONTROLS.filter((control) =>
		allowed.has(control.framework),
	);
}

export function getComplianceControl(
	controlId: string,
): ComplianceControl | undefined {
	const normalized = controlId.trim().toLowerCase();
	return COMPLIANCE_CONTROLS.find((control) => control.id === normalized);
}

export function controlIdsForActionType(actionType: string): string[] {
	const normalized = actionType.trim().toLowerCase();
	return COMPLIANCE_CONTROLS.filter((control) =>
		control.mappedActionTypes.includes(normalized),
	).map((control) => control.id);
}
