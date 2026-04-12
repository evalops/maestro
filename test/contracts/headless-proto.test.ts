import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	InterruptMessageSchema,
	ThinkingLevel,
	ToAgentEnvelopeSchema,
} from "../../packages/contracts/src/index.js";

describe("headless protobuf bootstrap", () => {
	it("exports generated protobuf schemas from the contracts package", () => {
		expect(ToAgentEnvelopeSchema.typeName).toBe("maestro.v1.ToAgentEnvelope");
		expect(ThinkingLevel.HIGH).toBeGreaterThan(ThinkingLevel.MEDIUM);
		const envelope = create(ToAgentEnvelopeSchema, {
			payload: {
				case: "interrupt",
				value: create(InterruptMessageSchema),
			},
		});
		expect(envelope.payload.case).toBe("interrupt");
	});
});
