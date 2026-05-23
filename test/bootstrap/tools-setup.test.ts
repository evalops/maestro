import { describe, expect, it } from "vitest";
import { createToolsAndSandbox } from "../../src/bootstrap/tools-setup.js";
import {
	CODEX_DEFAULT_TOOL_PROFILE,
	CODEX_EXTENDED_TOOL_PROFILE,
	CODEX_READ_ONLY_TOOL_PROFILE,
} from "../../src/codex/compatibility.js";

describe("createToolsAndSandbox", () => {
	it("uses the curated Codex tool profile for Codex app-server models by default", async () => {
		const result = await createToolsAndSandbox({
			modelApi: "openai-codex-app-server",
			cwd: process.cwd(),
		});

		expect(result.baseTools.map((tool) => tool.name)).toEqual(
			CODEX_DEFAULT_TOOL_PROFILE,
		);
		expect(result.allTools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(CODEX_DEFAULT_TOOL_PROFILE),
		);
		expect(result.allTools.map((tool) => tool.name)).not.toContain(
			"pipeline_search_contacts",
		);
	});

	it("honors explicit --tools selections for Codex app-server models", async () => {
		const result = await createToolsAndSandbox({
			modelApi: "openai-codex-app-server",
			parsedTools: ["read", "status"],
			cwd: process.cwd(),
		});

		expect(result.baseTools.map((tool) => tool.name)).toEqual([
			"read",
			"status",
		]);
	});

	it("honors named Codex tool profiles when no explicit --tools override is set", async () => {
		const originalProfile = process.env.MAESTRO_CODEX_TOOL_PROFILE;
		try {
			process.env.MAESTRO_CODEX_TOOL_PROFILE = "read-only";
			const readOnly = await createToolsAndSandbox({
				modelApi: "openai-codex-app-server",
				cwd: process.cwd(),
			});
			expect(readOnly.baseTools.map((tool) => tool.name)).toEqual(
				CODEX_READ_ONLY_TOOL_PROFILE,
			);

			process.env.MAESTRO_CODEX_TOOL_PROFILE = "extended";
			const extended = await createToolsAndSandbox({
				modelApi: "openai-codex-app-server",
				cwd: process.cwd(),
			});
			expect(extended.baseTools.map((tool) => tool.name)).toEqual(
				CODEX_EXTENDED_TOOL_PROFILE,
			);
		} finally {
			if (typeof originalProfile === "string") {
				process.env.MAESTRO_CODEX_TOOL_PROFILE = originalProfile;
			} else {
				delete process.env.MAESTRO_CODEX_TOOL_PROFILE;
			}
		}
	});
});
