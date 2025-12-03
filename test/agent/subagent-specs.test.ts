import { describe, expect, it } from "vitest";
import {
	SUBAGENT_SPECS,
	type SubagentType,
	TOOL_CATEGORIES,
	createCustomSpec,
	filterToolsForSubagent,
	formatSubagentDisplay,
	getAllSubagentTypes,
	getAllowedTools,
	getSubagentSpec,
	isToolAllowed,
	parseSubagentType,
	validateSpec,
} from "../../src/agent/subagent-specs.js";

describe("subagent-specs", () => {
	describe("TOOL_CATEGORIES", () => {
		it("should have read-only tools", () => {
			expect(TOOL_CATEGORIES.read).toContain("read");
			expect(TOOL_CATEGORIES.read).toContain("list");
			expect(TOOL_CATEGORIES.read).toContain("search");
		});

		it("should have write tools", () => {
			expect(TOOL_CATEGORIES.write).toContain("edit");
			expect(TOOL_CATEGORIES.write).toContain("write");
		});

		it("should have shell tools", () => {
			expect(TOOL_CATEGORIES.shell).toContain("bash");
		});
	});

	describe("SUBAGENT_SPECS", () => {
		it("should have all expected subagent types", () => {
			expect(SUBAGENT_SPECS.explorer).toBeDefined();
			expect(SUBAGENT_SPECS.planner).toBeDefined();
			expect(SUBAGENT_SPECS.coder).toBeDefined();
			expect(SUBAGENT_SPECS.reviewer).toBeDefined();
			expect(SUBAGENT_SPECS.researcher).toBeDefined();
			expect(SUBAGENT_SPECS.minimal).toBeDefined();
			expect(SUBAGENT_SPECS.custom).toBeDefined();
		});

		it("explorer should only have read-only tools", () => {
			const spec = SUBAGENT_SPECS.explorer;
			expect(spec.allowedTools).toContain("read");
			expect(spec.allowedTools).toContain("search");
			expect(spec.allowedTools).not.toContain("write");
			expect(spec.allowedTools).not.toContain("edit");
			expect(spec.allowedTools).not.toContain("bash");
		});

		it("coder should have all major tools", () => {
			const spec = SUBAGENT_SPECS.coder;
			expect(spec.allowedTools).toContain("read");
			expect(spec.allowedTools).toContain("write");
			expect(spec.allowedTools).toContain("edit");
			expect(spec.allowedTools).toContain("bash");
		});

		it("minimal should have very few tools", () => {
			const spec = SUBAGENT_SPECS.minimal;
			expect(spec.allowedTools.length).toBeLessThan(5);
		});
	});

	describe("getSubagentSpec", () => {
		it("should return spec for valid type", () => {
			const spec = getSubagentSpec("explorer");
			expect(spec.displayName).toBe("Explorer");
			expect(spec.allowMcp).toBe(false);
		});

		it("should return coder spec with full capabilities", () => {
			const spec = getSubagentSpec("coder");
			expect(spec.allowMcp).toBe(true);
			expect(spec.allowToolbox).toBe(true);
		});
	});

	describe("isToolAllowed", () => {
		it("should allow read tool for explorer", () => {
			expect(isToolAllowed("read", "explorer")).toBe(true);
		});

		it("should deny write tool for explorer", () => {
			expect(isToolAllowed("write", "explorer")).toBe(false);
		});

		it("should allow all tools for coder", () => {
			expect(isToolAllowed("read", "coder")).toBe(true);
			expect(isToolAllowed("write", "coder")).toBe(true);
			expect(isToolAllowed("bash", "coder")).toBe(true);
		});

		it("should deny oracle for explorer (in deniedTools)", () => {
			expect(isToolAllowed("oracle", "explorer")).toBe(false);
		});

		it("should respect custom spec overrides", () => {
			expect(
				isToolAllowed("bash", "explorer", { allowedTools: ["bash"] }),
			).toBe(true);
		});
	});

	describe("getAllowedTools", () => {
		it("should return allowed tools for explorer", () => {
			const tools = getAllowedTools("explorer");
			expect(tools).toContain("read");
			expect(tools).toContain("search");
			expect(tools).not.toContain("oracle"); // denied
		});

		it("should return allowed tools for coder", () => {
			const tools = getAllowedTools("coder");
			expect(tools.length).toBeGreaterThan(10);
		});
	});

	describe("filterToolsForSubagent", () => {
		const mockTools = [
			{ name: "read", run: () => {} },
			{ name: "write", run: () => {} },
			{ name: "bash", run: () => {} },
			{ name: "search", run: () => {} },
		];

		it("should filter tools for explorer", () => {
			const filtered = filterToolsForSubagent(mockTools, "explorer");
			const names = filtered.map((t) => t.name);
			expect(names).toContain("read");
			expect(names).toContain("search");
			expect(names).not.toContain("write");
			expect(names).not.toContain("bash");
		});

		it("should allow all tools for coder", () => {
			const filtered = filterToolsForSubagent(mockTools, "coder");
			expect(filtered.length).toBe(4);
		});
	});

	describe("parseSubagentType", () => {
		it("should parse valid types", () => {
			expect(parseSubagentType("explorer")).toBe("explorer");
			expect(parseSubagentType("CODER")).toBe("coder");
			expect(parseSubagentType("  planner  ")).toBe("planner");
		});

		it("should return null for invalid types", () => {
			expect(parseSubagentType("invalid")).toBeNull();
			expect(parseSubagentType("")).toBeNull();
		});
	});

	describe("formatSubagentDisplay", () => {
		it("should format subagent type for display", () => {
			const display = formatSubagentDisplay("explorer");
			expect(display).toContain("Explorer");
			expect(display).toContain("Read-only");
		});
	});

	describe("getAllSubagentTypes", () => {
		it("should return all subagent types with specs", () => {
			const types = getAllSubagentTypes();
			expect(types.length).toBeGreaterThanOrEqual(6);
			expect(types[0]).toHaveProperty("type");
			expect(types[0]).toHaveProperty("spec");
		});
	});

	describe("createCustomSpec", () => {
		it("should create custom spec based on base type", () => {
			const custom = createCustomSpec("explorer", {
				allowedTools: ["read", "bash"],
				displayName: "My Custom",
			});
			expect(custom.displayName).toBe("My Custom");
			expect(custom.allowedTools).toEqual(["read", "bash"]);
			// Should inherit other properties from explorer
			expect(custom.allowMcp).toBe(false);
		});
	});

	describe("validateSpec", () => {
		it("should validate valid spec", () => {
			const errors = validateSpec({
				allowedTools: ["read"],
				maxToolCallsPerTurn: 10,
			});
			expect(errors).toHaveLength(0);
		});

		it("should catch empty allowedTools", () => {
			const errors = validateSpec({ allowedTools: [] });
			expect(errors).toContain("allowedTools cannot be empty");
		});

		it("should catch invalid maxToolCallsPerTurn", () => {
			const errors = validateSpec({ maxToolCallsPerTurn: 0 });
			expect(errors).toContain("maxToolCallsPerTurn must be at least 1");
		});
	});
});
