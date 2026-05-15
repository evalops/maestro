import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../src/agent/types.js";
import {
	CODEX_DEFAULT_TOOL_PROFILE,
	CODEX_DYNAMIC_TOOL_CONFORMANCE,
	compileCodexDynamicToolSpecs,
	normalizeCodexDynamicToolInputSchema,
	selectCodexDefaultTools,
} from "../../src/codex/compatibility.js";
import { codingTools } from "../../src/tools/index.js";

const fixture = JSON.parse(
	readFileSync(
		join(process.cwd(), "test/fixtures/codex/app-server-dynamic-tools-v1.json"),
		"utf8",
	),
) as {
	dynamicToolSpec: {
		nameMaxLength: number;
		namespaceMaxLength: number;
		identifierPattern: string;
		reservedNames: string[];
		reservedNamespaces: string[];
		reservedNamePrefixes: string[];
		deferLoadingRequiresNamespace: boolean;
	};
	responsesSchema: {
		rootType: string;
		unsupportedTopLevelKeywords: string[];
	};
	dynamicToolCall: {
		method: string;
		responseContentItemTypes: string[];
	};
};

describe("Codex app-server compatibility contract", () => {
	it("tracks the upstream dynamic tool protocol fixture", () => {
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.nameMaxLength).toBe(
			fixture.dynamicToolSpec.nameMaxLength,
		);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.namespaceMaxLength).toBe(
			fixture.dynamicToolSpec.namespaceMaxLength,
		);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.identifierPattern.source).toBe(
			fixture.dynamicToolSpec.identifierPattern,
		);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.reservedNamespaces).toEqual(
			fixture.dynamicToolSpec.reservedNamespaces,
		);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.reservedNames).toEqual(
			fixture.dynamicToolSpec.reservedNames,
		);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.reservedNamePrefixes).toEqual(
			fixture.dynamicToolSpec.reservedNamePrefixes,
		);
		expect(
			CODEX_DYNAMIC_TOOL_CONFORMANCE.unsupportedTopLevelSchemaKeywords,
		).toEqual(fixture.responsesSchema.unsupportedTopLevelKeywords);
		expect(CODEX_DYNAMIC_TOOL_CONFORMANCE.dynamicToolCallMethod).toBe(
			fixture.dynamicToolCall.method,
		);
	});

	it("compiles the curated Codex default profile into Responses-safe dynamic tools", () => {
		const selected = selectCodexDefaultTools(codingTools);
		const compiled = compileCodexDynamicToolSpecs(selected);

		expect(selected.map((tool) => tool.name)).toEqual(
			CODEX_DEFAULT_TOOL_PROFILE,
		);
		expect(compiled.diagnostics).toEqual([]);
		expect(compiled.specs).toHaveLength(CODEX_DEFAULT_TOOL_PROFILE.length);
		expect(compiled.specs.map((spec) => spec.name)).toEqual(
			CODEX_DEFAULT_TOOL_PROFILE,
		);
		for (const spec of compiled.specs) {
			expect(spec.inputSchema).toMatchObject({ type: "object" });
			for (const keyword of fixture.responsesSchema
				.unsupportedTopLevelKeywords) {
				expect(spec.inputSchema).not.toHaveProperty(keyword);
			}
		}
	});

	it("renames invalid or reserved tool identifiers while preserving original bindings", () => {
		const tools: AgentTool[] = [
			{
				name: "mcp__ticket:lookup",
				description: "Look up a ticket.",
				parameters: Type.Object({ id: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
			{
				name: "mcp__ticket lookup",
				description: "Look up another ticket.",
				parameters: Type.Object({ id: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
		];

		const compiled = compileCodexDynamicToolSpecs(tools);

		expect(compiled.specs.map((spec) => spec.name)).toEqual([
			"maestro_mcp__ticket_lookup",
			"maestro_mcp__ticket_lookup_2",
		]);
		expect(compiled.bindings).toMatchObject([
			{
				codexName: "maestro_mcp__ticket_lookup",
				originalName: "mcp__ticket:lookup",
			},
			{
				codexName: "maestro_mcp__ticket_lookup_2",
				originalName: "mcp__ticket lookup",
			},
		]);
		expect(compiled.diagnostics).toEqual([
			expect.objectContaining({
				severity: "warning",
				code: "renamed_tool",
				toolName: "mcp__ticket:lookup",
			}),
			expect.objectContaining({
				severity: "warning",
				code: "renamed_tool",
				toolName: "mcp__ticket lookup",
			}),
		]);
	});

	it("preserves schema-valued additional properties when every union branch allows them", () => {
		const normalized = normalizeCodexDynamicToolInputSchema({
			anyOf: [
				{
					type: "object",
					properties: {
						mode: { const: "text", type: "string" },
					},
					additionalProperties: { type: "string" },
				},
				{
					type: "object",
					properties: {
						mode: { const: "count", type: "string" },
					},
					additionalProperties: { type: "number" },
				},
			],
		});

		expect(normalized.additionalProperties).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
	});

	it("keeps composed additional properties closed when any union branch is closed", () => {
		const normalized = normalizeCodexDynamicToolInputSchema({
			anyOf: [
				{
					type: "object",
					properties: {
						mode: { const: "text", type: "string" },
					},
					additionalProperties: { type: "string" },
				},
				{
					type: "object",
					properties: {
						mode: { const: "strict", type: "string" },
					},
					additionalProperties: false,
				},
			],
		});

		expect(normalized.additionalProperties).toBe(false);
	});

	it("keeps composed additional properties closed when a union mixes omitted and closed branches", () => {
		const normalized = normalizeCodexDynamicToolInputSchema({
			oneOf: [
				{
					type: "object",
					properties: {
						mode: { const: "default", type: "string" },
					},
				},
				{
					type: "object",
					properties: {
						mode: { const: "strict", type: "string" },
					},
					additionalProperties: false,
				},
			],
		});

		expect(normalized.additionalProperties).toBe(false);
	});
});
