import { describe, expect, it } from "vitest";
import { calculatePlanHint } from "../src/tui/plan-view.js";

describe("calculatePlanHint", () => {
	it("returns null when no goals exist", () => {
		expect(calculatePlanHint({})).toBeNull();
	});

	it("prefers the most recently updated goal", () => {
		const store = {
			One: {
				goal: "One",
				updatedAt: new Date("2024-01-01").toISOString(),
				items: [{ status: "pending" }, { status: "completed" }],
			},
			Two: {
				goal: "Ship CLI",
				updatedAt: new Date("2024-05-01").toISOString(),
				items: [{ status: "completed" }, { status: "completed" }],
			},
		};
		const hint = calculatePlanHint(store as any);
		expect(hint).toBe("Ship CLI: 2/2 done");
	});
});
