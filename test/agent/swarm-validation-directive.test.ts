import { describe, expect, it } from "vitest";
import { buildSwarmValidationDirective } from "../../src/agent/swarm/validation-directive.js";

describe("buildSwarmValidationDirective", () => {
	it("defaults to end-to-end validation against real integrations", () => {
		const directive = buildSwarmValidationDirective();
		expect(directive).toContain(
			"Validate end-to-end against real integrations",
		);
		expect(directive).toContain("Do not introduce mocks or stubs");
		expect(directive).toContain("report it as a blocker");
		expect(directive).not.toContain("explicitly approved to use mocks");
	});

	it("treats an undefined flag the same as the strict default", () => {
		expect(buildSwarmValidationDirective(undefined)).toBe(
			buildSwarmValidationDirective(false),
		);
	});

	it("relaxes to a mocks-allowed directive only on explicit opt-out", () => {
		const directive = buildSwarmValidationDirective(true);
		expect(directive).toContain("explicitly approved to use mocks");
		expect(directive).toContain("name exactly what was not exercised for real");
		expect(directive).not.toContain("Do not introduce mocks or stubs");
	});
});
