import { describe, expect, it } from "vitest";
import {
	MAESTRO_BUS_EVENT_CATALOG,
	MAESTRO_BUS_EVENT_TYPES,
	MAESTRO_RELEASE_GATE_EVENT_CATEGORIES,
	MaestroBusEventType,
	getMaestroBusEventCatalogEntry,
	getMissingMaestroReleaseGateEventCategories,
	isMaestroBusEventType,
	listMaestroBusEventCatalog,
	listMaestroBusEventCatalogByCategory,
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
	});

	it("recognizes only cataloged Maestro bus event types", () => {
		expect(isMaestroBusEventType("maestro.events.eval.scored")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.error.captured")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.tool_call.failed")).toBe(true);
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
		expect(listMaestroBusEventCatalogByCategory("error")).toEqual([
			expect.objectContaining({
				category: "error",
				type: MaestroBusEventType.ErrorCaptured,
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
		expect(listMaestroBusEventCatalogByCategory("artifact")).toEqual([
			expect.objectContaining({
				category: "artifact",
				type: MaestroBusEventType.ArtifactCreated,
			}),
		]);
		expect(listMaestroBusEventCatalogByCategory("final-status")).toEqual([
			expect.objectContaining({
				category: "final-status",
				type: MaestroBusEventType.FinalStatusReported,
			}),
		]);
	});
});
