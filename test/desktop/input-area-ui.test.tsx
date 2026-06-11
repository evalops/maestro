// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputArea } from "../../packages/desktop/src/renderer/components/Chat/InputArea";
import {
	buildMcpToolCollisionName,
	buildMcpToolName,
} from "../../src/mcp/names.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("desktop input area prompt suggestion", () => {
	let container: HTMLDivElement | null = null;
	let root: Root | null = null;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;
	});

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
			});
		}
		container?.remove();
		root = null;
		container = null;
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("fills the textarea when a suggestion is accepted", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				createElement(InputArea, {
					onSend: () => {},
					promptSuggestion: "Add a regression test for the desktop flow",
				}),
			);
			await flushAsyncWork();
		});

		const useButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Use",
		) as HTMLButtonElement | undefined;
		expect(useButton).toBeTruthy();

		await act(async () => {
			useButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe("Add a regression test for the desktop flow");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("inserts the canonical MCP tool mention", async () => {
		const serverName = "evil__server";
		const toolName = "delete__mcp__read";
		const canonicalToolName = buildMcpToolName(serverName, toolName);
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				servers: [
					{
						name: serverName,
						connected: true,
						tools: [
							{
								name: toolName,
								description: "Delete a resource",
							},
						],
					},
				],
			}),
		});

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				createElement(InputArea, {
					onSend: () => {},
				}),
			);
			await flushAsyncWork();
		});

		const mcpButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.title === "Insert MCP tool",
		) as HTMLButtonElement | undefined;
		expect(mcpButton).toBeTruthy();

		await act(async () => {
			mcpButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const toolButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes(`${serverName}/${toolName}`),
		) as HTMLButtonElement | undefined;
		expect(toolButton).toBeTruthy();

		await act(async () => {
			toolButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe(`@${canonicalToolName} `);
	});

	it("uses the resolved MCP tool name when status includes a collision suffix", async () => {
		const serverName = "docs";
		const toolName = "read";
		const canonicalToolName = buildMcpToolCollisionName(serverName, toolName);
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				servers: [
					{
						name: serverName,
						connected: true,
						tools: [
							{
								name: toolName,
								canonicalName: canonicalToolName,
								description: "Read documentation",
							},
						],
					},
				],
			}),
		});

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				createElement(InputArea, {
					onSend: () => {},
				}),
			);
			await flushAsyncWork();
		});

		const mcpButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.title === "Insert MCP tool",
		) as HTMLButtonElement | undefined;
		expect(mcpButton).toBeTruthy();

		await act(async () => {
			mcpButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const toolButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes(`${serverName}/${toolName}`),
		) as HTMLButtonElement | undefined;
		expect(toolButton).toBeTruthy();

		await act(async () => {
			toolButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe(`@${canonicalToolName} `);
	});
});
