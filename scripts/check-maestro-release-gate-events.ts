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

const releaseCatalog = listMaestroReleaseGateEventCatalog();
const query = buildMaestroReleaseGateEventQuery();
const issues: string[] = [];

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
	].join("\n"),
);
