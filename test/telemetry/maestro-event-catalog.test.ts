import { describe, expect, it } from "vitest";
import {
	MAESTRO_BUS_EVENT_CATALOG,
	MAESTRO_BUS_EVENT_TYPES,
	MaestroBusEventType,
	getMaestroBusEventCatalogEntry,
	isMaestroBusEventType,
	listMaestroBusEventCatalog,
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
	});

	it("recognizes only cataloged Maestro bus event types", () => {
		expect(isMaestroBusEventType("maestro.events.eval.scored")).toBe(true);
		expect(isMaestroBusEventType("maestro.events.unknown")).toBe(false);
	});
});
