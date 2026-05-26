import { describe, expect, it } from "vitest";
import {
	MAESTRO_BUS_EVENT_CATALOG,
	MAESTRO_BUS_EVENT_TYPES,
	MAESTRO_RELEASE_GATE_EVENT_CATEGORIES,
	MAESTRO_RELEASE_GATE_EVENT_SUBJECTS,
	MAESTRO_RELEASE_GATE_EVENT_SUBJECTS_BY_CATEGORY,
	MaestroBusEventType,
	buildMaestroReleaseGateEventQuery,
	getMaestroBusEventCatalogEntry,
	getMismatchedMaestroReleaseGateEventSubjectCategories,
	getMissingMaestroReleaseGateConsumerCategories,
	getMissingMaestroReleaseGateEventCategories,
	getUnexpectedMaestroReleaseGateEventSubjects,
	isMaestroBusEventType,
	listMaestroBusEventCatalog,
	listMaestroBusEventCatalogByCategory,
	listMaestroReleaseGateEventCatalog,
} from "../../src/telemetry/maestro-event-catalog.js";

describe("maestro event catalog", () => {
	it("defines one catalog entry for every event enum value", () => {
		expect(Object.keys(MAESTRO_BUS_EVENT_CATALOG).sort()).toEqual(
			[...MAESTRO_BUS_EVENT_TYPES].sort(),
		);
		expect(listMaestroBusEventCatalog()).toHaveLength(
			MAESTRO_BUS_EVENT_TYPES.length,
		);
	});

	it("maps event subjects to proto schemas and platform consumers", () => {
		expect(
			getMaestroBusEventCatalogEntry(MaestroBusEventType.ToolCallCompleted),
		).toMatchObject({
			category: "tool",
			dataSchema: "buf.build/evalops/proto/maestro.v1.ToolCallResult",
			protoAnyType: "type.googleapis.com/maestro.v1.ToolCallResult",
			subject: "maestro.events.tool_call.completed",
			platformConsumers: [
				"audit.maestro-events",
				"meter.maestro-tool-call-events",
				"release.maestro-tool-success-gates",
				"skills.maestro-tool-call-completed",
			],
		});
		expect(
			getMaestroBusEventCatalogEntry(MaestroBusEventType.SubagentDispatched),
		).toMatchObject({
			category: "agent",
			dataSchema: "buf.build/evalops/proto/maestro.v1.SubagentDispatch",
			protoAnyType: "type.googleapis.com/maestro.v1.SubagentDispatch",
			subject: "maestro.events.subagent.dispatched",
			platformConsumers: [
				"agents.maestro-subagent-dispatches",
				"audit.maestro-events",
				"meter.maestro-subagent-dispatches",
			],
		});
		expect(
			getMaestroBusEventCatalogEntry(MaestroBusEventType.InstallCheckCompleted),
		).toMatchObject({
			category: "install",
			dataSchema: "buf.build/evalops/proto/maestro.v1.PackageInstallCheck",
			protoAnyType: "type.googleapis.com/maestro.v1.PackageInstallCheck",
			subject: "maestro.events.install_check.completed",
			platformConsumers: [
				"audit.maestro-events",
				"meter.maestro-install-checks",
				"release.maestro-install-smoke",
			],
		});
		expect(
			getMaestroBusEventCatalogEntry(MaestroBusEventType.ToolCallFailed),
		).toMatchObject({
			category: "tool",
			dataSchema: "buf.build/evalops/proto/maestro.v1.ToolCallResult",
			protoAnyType: "type.googleapis.com/maestro.v1.ToolCallResult",
			subject: "maestro.events.tool_call.failed",
			platformConsumers: [
				"audit.maestro-events",
				"meter.maestro-tool-call-events",
				"release.maestro-tool-failure-gates",
				"skills.maestro-tool-call-failed",
			],
		});
		expect(
			getMaestroBusEventCatalogEntry(MaestroBusEventType.A2ATaskDispatched),
		).toMatchObject({
			category: "a2a",
			dataSchema:
				"buf.build/evalops/proto/maestro.v1.MaestroA2ADelegationEvent",
			protoAnyType: "type.googleapis.com/maestro.v1.MaestroA2ADelegationEvent",
			subject: "maestro.events.a2a.task.dispatched",
			platformConsumers: [
				"a2a.maestro-delegation-events",
				"audit.maestro-events",
				"meter.maestro-a2a-delegations",
			],
		});
	});

	it("recognizes only cataloged Maestro bus event types", () => {
		expect(isMaestroBusEventType("maestro.events.eval.scored")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.error.captured")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.tool_call.failed")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.a2a.peer.selected")).toBe(
			true,
		);
		expect(isMaestroBusEventType("maestro.events.a2a.task.completed")).toBe(
			true,
		);
		expect(isMaestroBusEventType("maestro.events.subagent.dispatched")).toBe(
			true,
		);
		expect(isMaestroBusEventType("maestro.events.unknown")).toBe(false);
	});

	it("keeps release-critical observability categories covered", () => {
		expect(MAESTRO_RELEASE_GATE_EVENT_CATEGORIES).toEqual([
			"install",
			"session",
			"tool",
			"approval",
			"error",
			"artifact",
			"final-status",
		]);
		expect(getMissingMaestroReleaseGateEventCategories()).toEqual([]);
		expect(getMissingMaestroReleaseGateConsumerCategories()).toEqual([]);
		expect(listMaestroBusEventCatalogByCategory("error")).toEqual([
			expect.objectContaining({
				category: "error",
				type: MaestroBusEventType.ErrorCaptured,
				platformConsumers: expect.arrayContaining([
					"release.maestro-error-gates",
				]),
			}),
		]);
		expect(listMaestroBusEventCatalogByCategory("tool")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: "tool",
					type: MaestroBusEventType.ToolCallAttempted,
				}),
				expect.objectContaining({
					category: "tool",
					type: MaestroBusEventType.ToolCallCompleted,
				}),
				expect.objectContaining({
					category: "tool",
					type: MaestroBusEventType.ToolCallFailed,
				}),
			]),
		);
		expect(listMaestroBusEventCatalogByCategory("a2a")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: "a2a",
					type: MaestroBusEventType.A2APeerSelected,
				}),
				expect.objectContaining({
					category: "a2a",
					type: MaestroBusEventType.A2ATaskDispatched,
				}),
				expect.objectContaining({
					category: "a2a",
					type: MaestroBusEventType.A2AEvidenceCompleted,
				}),
			]),
		);
		expect(listMaestroBusEventCatalogByCategory("artifact")).toEqual([
			expect.objectContaining({
				category: "artifact",
				type: MaestroBusEventType.ArtifactCreated,
				platformConsumers: expect.arrayContaining([
					"release.maestro-artifact-gates",
				]),
			}),
		]);
		expect(listMaestroBusEventCatalogByCategory("final-status")).toEqual([
			expect.objectContaining({
				category: "final-status",
				type: MaestroBusEventType.FinalStatusReported,
				platformConsumers: expect.arrayContaining([
					"release.maestro-final-status-gates",
				]),
			}),
		]);
	});

	it("builds a queryable release-gate manifest for required event subjects", () => {
		const releaseCatalog = listMaestroReleaseGateEventCatalog();
		const query = buildMaestroReleaseGateEventQuery();

		expect(releaseCatalog).toHaveLength(query.subjects.length);
		expect(
			releaseCatalog.every((entry) =>
				entry.platformConsumers.some((consumer) =>
					consumer.startsWith("release."),
				),
			),
		).toBe(true);
		expect(query.categories).toEqual(MAESTRO_RELEASE_GATE_EVENT_CATEGORIES);
		expect([...query.subjects].sort()).toEqual(
			[...MAESTRO_RELEASE_GATE_EVENT_SUBJECTS].sort(),
		);
		expect(query.subjectsByCategory).toEqual(
			MAESTRO_RELEASE_GATE_EVENT_SUBJECTS_BY_CATEGORY,
		);
		expect(query.subjects).not.toContain(MaestroBusEventType.SessionStarted);
		expect(query.subjects).not.toContain(MaestroBusEventType.ToolCallAttempted);
		expect(query.platformConsumers).toEqual(
			expect.arrayContaining([
				"release.maestro-install-smoke",
				"release.maestro-session-final-state",
				"release.maestro-tool-success-gates",
				"release.maestro-tool-failure-gates",
				"release.maestro-approval-gates",
				"release.maestro-error-gates",
				"release.maestro-artifact-gates",
				"release.maestro-final-status-gates",
			]),
		);
		expect(
			query.dataSchemas.every((schema) => schema.startsWith("buf.build/")),
		).toBe(true);
		expect(
			query.protoAnyTypes.every((typeUrl) =>
				typeUrl.startsWith("type.googleapis.com/"),
			),
		).toBe(true);
	});

	it("flags release-gate subjects outside the explicit release allowlist", () => {
		const catalogWithExtraReleaseSubject = listMaestroBusEventCatalog().map(
			(entry) =>
				entry.type === MaestroBusEventType.ToolCallAttempted
					? {
							...entry,
							platformConsumers: [
								...entry.platformConsumers,
								"release.maestro-tool-attempts",
							],
						}
					: entry,
		);

		expect(getUnexpectedMaestroReleaseGateEventSubjects()).toEqual([]);
		expect(
			getUnexpectedMaestroReleaseGateEventSubjects(
				catalogWithExtraReleaseSubject,
			),
		).toEqual([MaestroBusEventType.ToolCallAttempted]);
	});

	it("flags release-gate subjects assigned to the wrong category", () => {
		const catalogWithMisclassifiedToolFailure =
			listMaestroBusEventCatalog().map((entry) =>
				entry.type === MaestroBusEventType.ToolCallFailed
					? {
							...entry,
							category: "error" as const,
						}
					: entry,
			);

		expect(getMismatchedMaestroReleaseGateEventSubjectCategories()).toEqual([]);
		expect(
			getMismatchedMaestroReleaseGateEventSubjectCategories(
				catalogWithMisclassifiedToolFailure,
			),
		).toEqual([
			{
				actualSubjects: [MaestroBusEventType.ToolCallCompleted],
				category: "tool",
				expectedSubjects: [
					MaestroBusEventType.ToolCallCompleted,
					MaestroBusEventType.ToolCallFailed,
				],
				missingSubjects: [MaestroBusEventType.ToolCallFailed],
				unexpectedSubjects: [],
			},
			{
				actualSubjects: [
					MaestroBusEventType.ErrorCaptured,
					MaestroBusEventType.ToolCallFailed,
				],
				category: "error",
				expectedSubjects: [MaestroBusEventType.ErrorCaptured],
				missingSubjects: [],
				unexpectedSubjects: [MaestroBusEventType.ToolCallFailed],
			},
		]);
	});
});
