import { describe, expect, it } from "vitest";

import { StringEnum } from "../../src/agent/providers/typebox-helpers.js";

describe("StringEnum helper", () => {
	it("emits a Google-friendly enum shape without anyOf/const", () => {
		const schema = StringEnum(["fixed", "exponential"] as const, {
			description: "restart strategy",
		});

		expect(schema).toMatchObject({
			type: "string",
			enum: ["fixed", "exponential"],
			description: "restart strategy",
		});
		// Google rejects anyOf/const patterns produced by Type.Enum; ensure we don't emit them.
		expect((schema as Record<string, unknown>).anyOf).toBeUndefined();
		expect((schema as Record<string, unknown>).const).toBeUndefined();
	});
});
