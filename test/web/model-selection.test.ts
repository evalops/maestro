import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/models/registry.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/models/registry.js")
	>("../../src/models/registry.js");
	return {
		...actual,
		resolveAlias: (id: string) =>
			id === "fast-model" ? { provider: "openai", modelId: "gpt-fast" } : null,
		getFactoryDefaultModelSelection: () => ({
			provider: "anthropic",
			modelId: "claude-default",
		}),
		getRegisteredModels: () => [
			{ provider: "openai", id: "gpt-fast", name: "Fast", api: "chat" },
			{
				provider: "anthropic",
				id: "claude-default",
				name: "Claude",
				api: "chat",
			},
			{
				provider: "openai-codex",
				id: "gpt-5.5",
				name: "Codex",
				api: "openai-codex-app-server",
			},
		],
	};
});

import { handleModel } from "../../src/server/handlers/models.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
	parseModelInput,
} from "../../src/server/model-selection.js";

describe("model-selection", () => {
	it("parses provider/model with colon or slash", () => {
		expect(parseModelInput("openai:gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
		expect(parseModelInput("openai/gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});

	it("applies alias resolution", () => {
		const selection = determineModelSelection(
			"fast-model",
			"anthropic",
			"claude-3",
		);
		expect(selection).toEqual({ provider: "openai", modelId: "gpt-fast" });
	});

	it("falls back to factory default when no input provided", () => {
		const selection = determineModelSelection(null, "anthropic", "claude-3");
		expect(selection).toEqual({
			provider: "anthropic",
			modelId: "claude-default",
		});
	});

	it("preserves registered providers for bare model ids", () => {
		const selection = determineModelSelection(
			"claude-default",
			"openai-codex",
			"gpt-5.5",
		);
		expect(selection).toEqual({
			provider: "anthropic",
			modelId: "claude-default",
		});
	});

	it("requires registered models", () => {
		expect(() =>
			getRegisteredModelOrThrow({ provider: "missing", modelId: "none" }),
		).toThrow(/not found/);
	});

	it("does not require legacy credentials for Codex app-server selection writes", async () => {
		const req = new PassThrough() as PassThrough & IncomingMessage;
		req.method = "POST";
		req.headers = {};

		let responseBody = "";
		const res = {
			headersSent: false,
			writableEnded: false,
			writeHead: vi.fn(),
			end: vi.fn((body?: string | Buffer) => {
				responseBody = body?.toString() ?? "";
			}),
		} as unknown as ServerResponse;
		const ensureCredential = vi.fn();
		const setModelSelection = vi.fn();

		const response = handleModel(req, res, {
			corsHeaders: {},
			getCurrentSelection: () => ({
				provider: "openai-codex",
				modelId: "gpt-5.5",
			}),
			ensureCredential,
			setModelSelection,
		} as never);

		req.end(JSON.stringify({ model: "openai-codex/gpt-5.5" }));
		await response;

		expect(ensureCredential).not.toHaveBeenCalled();
		expect(setModelSelection).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "openai-codex",
				id: "gpt-5.5",
				api: "openai-codex-app-server",
			}),
		);
		expect(responseBody).toContain('"provider":"openai-codex"');
	});
});
