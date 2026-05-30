#!/usr/bin/env node
// @ts-check

export const RELEASE_OBSERVABILITY_QUERY_SCHEMA =
	"evalops.maestro.release-observability-query.v1";

export const REQUIRED_OBSERVABILITY_QUERY_TRACES = [
	"install",
	"session",
	"tool",
	"search",
	"approval",
	"error",
	"artifact",
	"agent-runtime-lifecycle",
	"final-status",
];

export const RELEASE_OBSERVABILITY_QUERY_DESCRIPTORS = {
	install: {
		subjects: ["maestro.events.install_check.completed"],
		platformConsumers: ["release.maestro-install-smoke"],
		filterFields: ["packageSpec", "installer", "installable"],
	},
	session: {
		subjects: ["maestro.sessions.session.closed"],
		platformConsumers: ["release.maestro-session-final-state"],
		filterFields: ["sessionId", "mode", "finalStatus"],
	},
	tool: {
		subjects: [
			"maestro.events.tool_call.attempted",
			"maestro.events.tool_call.completed",
			"maestro.events.tool_call.failed",
		],
		platformConsumers: [
			"release.maestro-tool-attempt-gates",
			"release.maestro-tool-success-gates",
			"release.maestro-tool-failure-gates",
		],
		filterFields: ["toolCallId", "toolName", "mode", "toolExecutionId"],
	},
	search: {
		subjects: ["maestro.events.tool_call.completed"],
		platformConsumers: ["release.maestro-tool-success-gates"],
		filterFields: ["toolCallId", "toolName=search", "mode", "toolExecutionId"],
	},
	approval: {
		subjects: ["maestro.events.approval_hit"],
		platformConsumers: ["release.maestro-approval-gates"],
		filterFields: ["approvalRequestId", "mode", "toolExecutionId"],
	},
	error: {
		subjects: ["maestro.events.error.captured"],
		platformConsumers: ["release.maestro-error-gates"],
		filterFields: ["status", "mode", "expectedCount"],
	},
	artifact: {
		subjects: ["maestro.events.artifact.created"],
		platformConsumers: ["release.maestro-artifact-gates"],
		filterFields: ["artifactId", "path", "mode"],
	},
	"agent-runtime-lifecycle": {
		subjects: ["maestro.sessions.session.closed"],
		platformConsumers: [
			"release.maestro-session-final-state",
			"release.maestro-tool-success-gates",
		],
		filterFields: ["sessionId", "pendingRequestId", "toolExecutionId"],
		platformRecords: [
			"AgentRuntimeRun",
			"AgentRuntimeRunStep",
			"ToolExecution",
		],
	},
	"final-status": {
		subjects: ["maestro.events.final_status.reported"],
		platformConsumers: ["release.maestro-final-status-gates"],
		filterFields: ["sessionId", "mode", "status"],
	},
};

function isObject(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string")
		: [];
}

export function releaseObservabilityQueryDescriptor(traceType) {
	const descriptor = RELEASE_OBSERVABILITY_QUERY_DESCRIPTORS[traceType];
	if (!descriptor) {
		return undefined;
	}
	return {
		schemaVersion: RELEASE_OBSERVABILITY_QUERY_SCHEMA,
		traceType,
		subjects: [...descriptor.subjects],
		platformConsumers: [...descriptor.platformConsumers],
		filterFields: [...descriptor.filterFields],
		...(descriptor.platformRecords
			? { platformRecords: [...descriptor.platformRecords] }
			: {}),
	};
}

export function releaseObservabilityQueryDescriptorIsValid(entry, traceType) {
	const expected = RELEASE_OBSERVABILITY_QUERY_DESCRIPTORS[traceType];
	const query = isObject(entry?.query)
		? entry.query
		: isObject(entry)
			? entry
			: {};
	const subjects = stringArray(query?.subjects);
	const platformConsumers = stringArray(query?.platformConsumers);
	const filterFields = stringArray(query?.filterFields);
	const platformRecords = stringArray(query?.platformRecords);
	return (
		isObject(expected) &&
		query.schemaVersion === RELEASE_OBSERVABILITY_QUERY_SCHEMA &&
		query.traceType === traceType &&
		expected.subjects.every((subject) => subjects.includes(subject)) &&
		expected.platformConsumers.every((consumer) =>
			platformConsumers.includes(consumer),
		) &&
		expected.filterFields.every((field) => filterFields.includes(field)) &&
		(expected.platformRecords ?? []).every((record) =>
			platformRecords.includes(record),
		)
	);
}
