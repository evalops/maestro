/**
 * TDD tests for SubagentSpecs — verify role-based tool filtering works
 * correctly for all agent types. These are the access control rules
 * that determine what each agent role can do.
 */
import { describe, expect, it } from "vitest";

import {
	TOOL_CATEGORIES,
	filterToolsForSubagent,
	getAllowedTools,
	getSubagentSpec,
	isToolAllowed,
} from "../../../packages/core/src/index.js";
import type { SubagentType } from "../../../packages/core/src/index.js";

describe("SubagentSpecs", () => {
	const ALL_TYPES: SubagentType[] = [
		"explorer",
		"planner",
		"coder",
		"reviewer",
		"researcher",
		"minimal",
		"custom",
	];

	describe("getSubagentSpec", () => {
		it("returns a spec for every known type", () => {
			for (const type of ALL_TYPES) {
				const spec = getSubagentSpec(type);
				expect(spec).toBeDefined();
				expect(spec.displayName).toBeTruthy();
				expect(spec.description).toBeTruthy();
				expect(Array.isArray(spec.allowedTools)).toBe(true);
			}
		});

		it("specs have non-empty allowed tools", () => {
			for (const type of ALL_TYPES) {
				const spec = getSubagentSpec(type);
				expect(spec.allowedTools.length).toBeGreaterThan(0);
			}
		});
	});

	describe("TOOL_CATEGORIES", () => {
		it("has read category with expected tools", () => {
			expect(TOOL_CATEGORIES.read).toBeDefined();
			expect(TOOL_CATEGORIES.read).toContain("read");
			expect(TOOL_CATEGORIES.read).toContain("search");
		});

		it("has write category with edit and write", () => {
			expect(TOOL_CATEGORIES.write).toBeDefined();
			expect(TOOL_CATEGORIES.write).toContain("edit");
			expect(TOOL_CATEGORIES.write).toContain("write");
		});

		it("has shell category with bash", () => {
			expect(TOOL_CATEGORIES.shell).toBeDefined();
			expect(TOOL_CATEGORIES.shell).toContain("bash");
		});

		it("has web category", () => {
			expect(TOOL_CATEGORIES.web).toBeDefined();
			expect(TOOL_CATEGORIES.web.length).toBeGreaterThan(0);
		});
	});

	describe("isToolAllowed — security boundaries", () => {
		describe("explorer (read-only)", () => {
			it("can read files", () => {
				expect(isToolAllowed("read", "explorer")).toBe(true);
			});

			it("can search", () => {
				expect(isToolAllowed("search", "explorer")).toBe(true);
			});

			it("cannot write files", () => {
				expect(isToolAllowed("write", "explorer")).toBe(false);
			});

			it("cannot edit files", () => {
				expect(isToolAllowed("edit", "explorer")).toBe(false);
			});

			it("cannot execute shell commands", () => {
				expect(isToolAllowed("bash", "explorer")).toBe(false);
			});

			it("cannot use background tasks", () => {
				expect(isToolAllowed("background_tasks", "explorer")).toBe(false);
			});
		});

		describe("coder (full access)", () => {
			it("can read files", () => {
				expect(isToolAllowed("read", "coder")).toBe(true);
			});

			it("can write files", () => {
				expect(isToolAllowed("write", "coder")).toBe(true);
			});

			it("can edit files", () => {
				expect(isToolAllowed("edit", "coder")).toBe(true);
			});

			it("can execute shell commands", () => {
				expect(isToolAllowed("bash", "coder")).toBe(true);
			});

			it("can use background tasks", () => {
				expect(isToolAllowed("background_tasks", "coder")).toBe(true);
			});
		});

		describe("reviewer (read + web)", () => {
			it("can read files", () => {
				expect(isToolAllowed("read", "reviewer")).toBe(true);
			});

			it("cannot write files", () => {
				expect(isToolAllowed("write", "reviewer")).toBe(false);
			});

			it("cannot execute shell commands", () => {
				expect(isToolAllowed("bash", "reviewer")).toBe(false);
			});
		});

		describe("researcher (web + read)", () => {
			it("can search the web", () => {
				expect(isToolAllowed("websearch", "researcher")).toBe(true);
			});

			it("can fetch web content", () => {
				expect(isToolAllowed("webfetch", "researcher")).toBe(true);
			});

			it("can read files", () => {
				expect(isToolAllowed("read", "researcher")).toBe(true);
			});

			it("cannot write files", () => {
				expect(isToolAllowed("write", "researcher")).toBe(false);
			});

			it("cannot execute shell commands", () => {
				expect(isToolAllowed("bash", "researcher")).toBe(false);
			});
		});

		describe("minimal (bare minimum)", () => {
			it("can read", () => {
				expect(isToolAllowed("read", "minimal")).toBe(true);
			});

			it("cannot write", () => {
				expect(isToolAllowed("write", "minimal")).toBe(false);
			});

			it("cannot bash", () => {
				expect(isToolAllowed("bash", "minimal")).toBe(false);
			});

			it("cannot web search", () => {
				expect(isToolAllowed("websearch", "minimal")).toBe(false);
			});

			it("has fewer tools than explorer", () => {
				const minimalTools = getAllowedTools("minimal");
				const explorerTools = getAllowedTools("explorer");
				expect(minimalTools.length).toBeLessThanOrEqual(explorerTools.length);
			});
		});

		describe("planner (read + interactive)", () => {
			it("can read files", () => {
				expect(isToolAllowed("read", "planner")).toBe(true);
			});

			it("can use todo", () => {
				expect(isToolAllowed("todo", "planner")).toBe(true);
			});

			it("cannot write files", () => {
				expect(isToolAllowed("write", "planner")).toBe(false);
			});

			it("cannot bash", () => {
				expect(isToolAllowed("bash", "planner")).toBe(false);
			});
		});
	});

	describe("getAllowedTools", () => {
		it("returns more tools for coder than explorer", () => {
			const coderTools = getAllowedTools("coder");
			const explorerTools = getAllowedTools("explorer");
			expect(coderTools.length).toBeGreaterThan(explorerTools.length);
		});

		it("returns non-empty for all types", () => {
			for (const type of ALL_TYPES) {
				expect(getAllowedTools(type).length).toBeGreaterThan(0);
			}
		});

		it("coder has the most tools", () => {
			const coderCount = getAllowedTools("coder").length;
			for (const type of ALL_TYPES) {
				if (type === "custom") continue; // custom can be anything
				expect(getAllowedTools(type).length).toBeLessThanOrEqual(coderCount);
			}
		});
	});

	describe("filterToolsForSubagent", () => {
		const mockTools = [
			{ name: "read", execute: () => {} },
			{ name: "write", execute: () => {} },
			{ name: "bash", execute: () => {} },
			{ name: "search", execute: () => {} },
			{ name: "websearch", execute: () => {} },
			{ name: "edit", execute: () => {} },
		];

		it("filters tools for explorer (keeps read, search)", () => {
			const filtered = filterToolsForSubagent(mockTools, "explorer");
			const names = filtered.map((t: { name: string }) => t.name);
			expect(names).toContain("read");
			expect(names).toContain("search");
			expect(names).not.toContain("write");
			expect(names).not.toContain("bash");
			expect(names).not.toContain("edit");
		});

		it("filters tools for coder (keeps all except web-only)", () => {
			const filtered = filterToolsForSubagent(mockTools, "coder");
			const names = filtered.map((t: { name: string }) => t.name);
			// Coder has read, write, shell, interactive, github, advanced — NOT web
			expect(names).toContain("read");
			expect(names).toContain("write");
			expect(names).toContain("bash");
			expect(names).toContain("edit");
			expect(names).toContain("search");
			// websearch is a web-category tool, not in coder's categories
			expect(names).not.toContain("websearch");
		});

		it("filters tools for reviewer (keeps read, websearch)", () => {
			const filtered = filterToolsForSubagent(mockTools, "reviewer");
			const names = filtered.map((t: { name: string }) => t.name);
			expect(names).toContain("read");
			expect(names).not.toContain("write");
			expect(names).not.toContain("bash");
		});

		it("returns empty array when no tools match", () => {
			const noMatchTools = [{ name: "nonexistent_tool", execute: () => {} }];
			const filtered = filterToolsForSubagent(noMatchTools, "minimal");
			expect(filtered.length).toBe(0);
		});
	});

	describe("spec properties", () => {
		it("explorer does not allow MCP", () => {
			const spec = getSubagentSpec("explorer");
			expect(spec.allowMcp).toBe(false);
		});

		it("coder allows MCP", () => {
			const spec = getSubagentSpec("coder");
			expect(spec.allowMcp).toBe(true);
		});

		it("coder requires confirmation", () => {
			const spec = getSubagentSpec("coder");
			expect(spec.requireConfirmation).toBe(true);
		});

		it("explorer does not require confirmation", () => {
			const spec = getSubagentSpec("explorer");
			expect(spec.requireConfirmation).toBe(false);
		});

		it("specs have maxToolCallsPerTurn limits", () => {
			for (const type of ALL_TYPES) {
				const spec = getSubagentSpec(type);
				if (spec.maxToolCallsPerTurn !== undefined) {
					expect(spec.maxToolCallsPerTurn).toBeGreaterThan(0);
				}
			}
		});
	});
});
