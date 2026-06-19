import { afterEach, describe, expect, it, vi } from "vitest";
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
	getSubagentTypeFromEnv,
	isToolAllowed,
	parseSubagentType,
	validateSpec,
} from "../../src/agent/subagent-specs.js";
import { conductorClientTools } from "../../src/tools/conductor-client.js";

describe("subagent-specs", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("TOOL_CATEGORIES", () => {
		it("should have read-only tools", () => {
			expect(TOOL_CATEGORIES.read).toContain("read");
			expect(TOOL_CATEGORIES.read).toContain("list");
			expect(TOOL_CATEGORIES.read).toContain("search");
		});

		it("should have write tools", () => {
			expect(TOOL_CATEGORIES.write).toContain("apply_patch");
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
			expect(SUBAGENT_SPECS["test-runner"]).toBeDefined();
			expect(SUBAGENT_SPECS.researcher).toBeDefined();
			expect(SUBAGENT_SPECS["browser-qa"]).toBeDefined();
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
			expect(spec.allowedTools).toContain("apply_patch");
			expect(spec.allowedTools).toContain("write");
			expect(spec.allowedTools).toContain("edit");
			expect(spec.allowedTools).toContain("bash");
		});

		it("minimal should have very few tools", () => {
			const spec = SUBAGENT_SPECS.minimal;
			expect(spec.allowedTools.length).toBeLessThan(5);
		});

		it("browser qa should capture product evidence without write access", () => {
			const spec = SUBAGENT_SPECS["browser-qa"];
			expect(spec.allowedTools).toContain("agent_browser");
			expect(spec.allowedTools).toContain("browser_screenshot");
			expect(spec.allowedTools).toContain("browser_record");
			expect(spec.allowedTools).toContain("browser_operator");
			expect(spec.allowedTools).toContain("capture_screenshot");
			expect(spec.allowedTools).toContain("capture_console_errors");
			expect(spec.allowedTools).toContain("capture_network");
			expect(spec.allowedTools).not.toContain("write");
			expect(spec.requireConfirmation).toBe(false);
		});

		it("browser qa keeps real Conductor browser control and evidence tools", () => {
			const filtered = filterToolsForSubagent(
				conductorClientTools,
				"browser-qa",
			).map((tool) => tool.name);

			expect(filtered).toEqual(
				expect.arrayContaining([
					"browser_operator",
					"capture_screenshot",
					"capture_console_errors",
					"capture_network",
					"native_key_up",
				]),
			);
		});

		it("test runner can execute checks without write access", () => {
			const spec = SUBAGENT_SPECS["test-runner"];
			expect(spec.allowedTools).toContain("bash");
			expect(spec.allowedTools).toContain("background_tasks");
			expect(spec.allowedTools).not.toContain("write");
			expect(spec.allowedTools).not.toContain("edit");
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

		it("normalizes tool names before allowed and denied checks", () => {
			expect(isToolAllowed("re\u200bad", "explorer")).toBe(true);
			expect(isToolAllowed("or\u200bacle", "explorer")).toBe(false);
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

		it("normalizes custom allow and deny lists", () => {
			const tools = getAllowedTools("coder", {
				allowedTools: ["apply-patch", "read", "rea\u200bd"],
				deniedTools: ["appl\u200by_patch"],
			});
			expect(tools).toEqual(["read"]);
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

		it("normalizes tool names when filtering", () => {
			const filtered = filterToolsForSubagent(
				[
					{ name: "rea\u200bd", run: () => {} },
					{ name: "ba\u200bsh", run: () => {} },
				],
				"explorer",
			);
			expect(filtered.map((tool) => tool.name)).toEqual(["rea\u200bd"]);
		});

		it("respects normalized custom allowlists", () => {
			const filtered = filterToolsForSubagent(
				[{ name: "apply_patch", run: () => {} }],
				"explorer",
				{ allowedTools: ["apply-patch"] },
			);
			expect(filtered.map((tool) => tool.name)).toEqual(["apply_patch"]);
			expect(
				isToolAllowed("apply_patch", "explorer", {
					allowedTools: ["apply-patch"],
				}),
			).toBe(true);
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
			expect(parseSubagentType("co\u200bder")).toBe("coder");
			expect(parseSubagentType("browser-qa")).toBe("browser-qa");
			expect(parseSubagentType("browser_qa")).toBe("browser-qa");
			expect(parseSubagentType("dogfood")).toBe("browser-qa");
			expect(parseSubagentType("product-qa")).toBe("browser-qa");
			expect(parseSubagentType("test-runner")).toBe("test-runner");
			expect(parseSubagentType("qa")).toBe("test-runner");
			expect(parseSubagentType("ci-monitor")).toBe("test-runner");
			expect(parseSubagentType("test")).toBe("test-runner");
		});

		it("should return null for invalid types", () => {
			expect(parseSubagentType("invalid")).toBeNull();
			expect(parseSubagentType("")).toBeNull();
		});
	});

	describe("getSubagentTypeFromEnv", () => {
		it("normalizes underscore aliases from MAESTRO_SUBAGENT_TYPE", () => {
			vi.stubEnv("MAESTRO_SUBAGENT_TYPE", "browser_qa");

			expect(getSubagentTypeFromEnv()).toBe("browser-qa");
		});

		it("normalizes Codex dispatch aliases from MAESTRO_SUBAGENT_TYPE", () => {
			vi.stubEnv("MAESTRO_SUBAGENT_TYPE", "dogfood");

			expect(getSubagentTypeFromEnv()).toBe("browser-qa");
		});

		it("maps test execution aliases to a shell-capable test-runner spec", () => {
			vi.stubEnv("MAESTRO_SUBAGENT_TYPE", "qa");

			expect(getSubagentTypeFromEnv()).toBe("test-runner");
			expect(getAllowedTools("test-runner")).toContain("bash");
		});

		it("falls back to coder for invalid MAESTRO_SUBAGENT_TYPE values", () => {
			vi.stubEnv("MAESTRO_SUBAGENT_TYPE", "not-a-real-lane");

			expect(getSubagentTypeFromEnv()).toBe("coder");
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
