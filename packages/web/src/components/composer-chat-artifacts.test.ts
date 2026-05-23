import { fixture, html } from "@open-wc/testing";
import { assert, afterEach, describe, it, vi } from "vitest";
import "./composer-chat.js";
import type { ComposerChat } from "./composer-chat.js";

describe("ComposerChat artifact client tools", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns model-facing artifact error codes for missing log artifacts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		const element = await fixture<ComposerChat>(
			html`<composer-chat></composer-chat>`,
		);
		const sendClientToolResult = vi.fn().mockResolvedValue(undefined);
		(element as unknown as { apiClient: unknown }).apiClient = {
			sendClientToolResult,
		};

		await (
			element as unknown as {
				handleClientToolRequest(
					toolCallId: string,
					toolName: string,
					args: unknown,
				): Promise<void>;
			}
		).handleClientToolRequest("tool-1", "artifacts", {
			command: "logs",
			filename: "missing.html",
		});

		assert.equal(sendClientToolResult.mock.calls[0]?.[0].isError, true);
		assert.include(
			sendClientToolResult.mock.calls[0]?.[0].content[0].text,
			"[artifact.not_found]",
		);
	});
});
