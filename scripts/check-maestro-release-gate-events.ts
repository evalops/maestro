#!/usr/bin/env tsx

import {
	MAESTRO_RELEASE_GATE_EVENT_CATEGORIES,
	MAESTRO_RELEASE_GATE_EVENT_SUBJECTS,
	buildMaestroReleaseGateEventQuery,
	getMismatchedMaestroReleaseGateEventSubjectCategories,
	getMissingMaestroReleaseGateConsumerCategories,
	getMissingMaestroReleaseGateEventCategories,
	getUnexpectedMaestroReleaseGateEventSubjects,
	listMaestroReleaseGateEventCatalog,
} from "../src/telemetry/maestro-event-catalog.js";
import {
	REQUIRED_OBSERVABILITY_QUERY_TRACES,
	releaseObservabilityQueryDescriptor,
} from "./release-observability-query-contract.js";

const releaseCatalog = listMaestroReleaseGateEventCatalog();
const query = buildMaestroReleaseGateEventQuery();
const issues: string[] = [];
const querySubjects = new Set<string>(query.subjects);
const queryPlatformConsumers = new Set<string>(query.platformConsumers);
const releaseObservabilityTraceTypes = new Set<string>(
	REQUIRED_OBSERVABILITY_QUERY_TRACES,
);

for (const category of getMissingMaestroReleaseGateEventCategories()) {
	issues.push(`missing release-gate event category: ${category}`);
}

for (const category of getMissingMaestroReleaseGateConsumerCategories()) {
	issues.push(`missing release.* platform consumer for category: ${category}`);
}

for (const category of MAESTRO_RELEASE_GATE_EVENT_CATEGORIES) {
	const subjects = query.subjectsByCategory[category];
	if (subjects.length === 0) {
		issues.push(`missing query subjects for category: ${category}`);
	}
}

for (const mismatch of getMismatchedMaestroReleaseGateEventSubjectCategories()) {
	if (mismatch.missingSubjects.length > 0) {
		issues.push(
			`category ${mismatch.category} is missing release-gate query subjects: ${mismatch.missingSubjects.join(", ")}`,
		);
	}
	if (mismatch.unexpectedSubjects.length > 0) {
		issues.push(
			`category ${mismatch.category} has unexpected release-gate query subjects: ${mismatch.unexpectedSubjects.join(", ")}`,
		);
	}
}

for (const subject of MAESTRO_RELEASE_GATE_EVENT_SUBJECTS) {
	if (!query.subjects.includes(subject)) {
		issues.push(`missing release-gate query subject: ${subject}`);
	}
}

for (const subject of getUnexpectedMaestroReleaseGateEventSubjects()) {
	issues.push(`unexpected release-gate query subject: ${subject}`);
}

for (const category of MAESTRO_RELEASE_GATE_EVENT_CATEGORIES) {
	if (!releaseObservabilityTraceTypes.has(category)) {
		issues.push(
			`missing release observability query trace for category: ${category}`,
		);
	}
}

for (const traceType of REQUIRED_OBSERVABILITY_QUERY_TRACES) {
	const descriptor = releaseObservabilityQueryDescriptor(traceType);
	if (!descriptor) {
		issues.push(`missing release observability query descriptor: ${traceType}`);
		continue;
	}

	for (const subject of descriptor.subjects) {
		if (!querySubjects.has(subject)) {
			issues.push(
				`release observability query ${traceType} references non-release-gated subject: ${subject}`,
			);
		}
	}

	for (const consumer of descriptor.platformConsumers) {
		if (
			consumer.startsWith("release.") &&
			!queryPlatformConsumers.has(consumer)
		) {
			issues.push(
				`release observability query ${traceType} references unknown release consumer: ${consumer}`,
			);
		}
	}
}

for (const category of MAESTRO_RELEASE_GATE_EVENT_CATEGORIES) {
	const descriptor = releaseObservabilityQueryDescriptor(category);
	if (!descriptor) {
		continue;
	}
	const descriptorSubjects = new Set<string>(descriptor.subjects);
	const descriptorConsumers = new Set<string>(descriptor.platformConsumers);
	for (const subject of query.subjectsByCategory[category]) {
		if (!descriptorSubjects.has(subject)) {
			issues.push(
				`release observability query ${category} is missing release-gated subject: ${subject}`,
			);
		}
	}
	for (const consumer of new Set(
		releaseCatalog
			.filter((entry) => entry.category === category)
			.flatMap((entry) => entry.platformConsumers)
			.filter((consumer) => consumer.startsWith("release.")),
	)) {
		if (!descriptorConsumers.has(consumer)) {
			issues.push(
				`release observability query ${category} is missing release consumer: ${consumer}`,
			);
		}
	}
}

for (const entry of releaseCatalog) {
	if (entry.subject !== entry.type) {
		issues.push(`${entry.type} subject does not match its event type`);
	}
	if (!entry.dataSchema.startsWith("buf.build/evalops/proto/")) {
		issues.push(`${entry.type} dataSchema is not a buf schema URL`);
	}
	if (!entry.protoAnyType.startsWith("type.googleapis.com/")) {
		issues.push(`${entry.type} protoAnyType is not a protobuf Any URL`);
	}
	if (!entry.platformConsumers.includes("audit.maestro-events")) {
		issues.push(`${entry.type} is missing audit.maestro-events`);
	}
	if (
		!entry.platformConsumers.some((consumer) =>
			consumer.startsWith("release."),
		)
	) {
		issues.push(`${entry.type} is missing a release.* platform consumer`);
	}
}

if (issues.length > 0) {
	console.error("Maestro release-gate event catalog is incomplete:");
	for (const issue of issues) {
		console.error(`- ${issue}`);
	}
	process.exit(1);
}

console.log(
	[
		`Maestro release-gate event catalog covers ${query.categories.length} category(s).`,
		`Queryable subjects: ${query.subjects.join(", ")}`,
		`Release consumers: ${query.platformConsumers
			.filter((consumer) => consumer.startsWith("release."))
			.join(", ")}`,
		`Release observability traces: ${REQUIRED_OBSERVABILITY_QUERY_TRACES.join(", ")}`,
	].join("\n"),
);
