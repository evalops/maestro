// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsRuntimeSection } from "../../packages/desktop/src/renderer/components/Settings/ToolsRuntimeSection";

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function createProps(
	overrides: Partial<ComponentProps<typeof ToolsRuntimeSection>> = {},
): ComponentProps<typeof ToolsRuntimeSection> {
	return {
		lspStatus: null,
		lspDetections: [],
		onLspAction: vi.fn(),
		onDetectLsp: vi.fn(),
		mcpStatus: {
			authPresets: [
				{
					name: "linear-auth",
					scope: "local",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
				},
			],
			servers: [
				{
					name: "linear",
					connected: true,
					scope: "local",
					transport: "http",
					resources: ["linear://workspace"],
					prompts: ["summarize-issue"],
					promptDetails: [
						{
							name: "summarize-issue",
							title: "Summarize Issue",
							description: "Summarize a Linear issue",
							arguments: [
								{
									name: "ISSUE",
									description: "Issue identifier",
									required: true,
								},
							],
						},
					],
				},
			],
		},
		expandedMcpServer: null,
		onToggleMcpServer: vi.fn(),
		onRefreshMcpStatus: vi.fn(),
		onSearchMcpRegistry: vi.fn().mockResolvedValue({
			query: "",
			entries: [],
		}),
		onImportMcpRegistry: vi.fn().mockResolvedValue({
			name: "linear",
			scope: "local",
			server: {
				transport: "http",
			},
		}),
		onAddMcpServer: vi.fn(),
		onAddMcpAuthPreset: vi.fn(),
		onUpdateMcpServer: vi.fn(),
		onUpdateMcpAuthPreset: vi.fn().mockResolvedValue({
			name: "linear-auth",
			scope: "local",
			preset: {
				name: "linear-auth",
			},
		}),
		onRemoveMcpServer: vi.fn(),
		onRemoveMcpAuthPreset: vi.fn(),
		onReadMcpResource: vi.fn().mockResolvedValue({
			contents: [
				{
					uri: "linear://workspace",
					text: "workspace content",
					mimeType: "text/plain",
				},
			],
		}),
		onGetMcpPrompt: vi.fn().mockResolvedValue({
			description: "Summarize a Linear issue",
			messages: [
				{
					role: "user",
					content: "Summarize issue MAE-1",
				},
			],
		}),
		composerStatus: null,
		selectedComposer: "",
		onSelectedComposerChange: vi.fn(),
		onRefreshComposers: vi.fn(),
		onActivateComposer: vi.fn(),
		onDeactivateComposer: vi.fn(),
		...overrides,
	};
}

describe("ToolsRuntimeSection UI", () => {
	let container: HTMLDivElement | undefined;
	let root: Root | undefined;

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
				await flushAsyncWork(1);
			});
		}
		container?.remove();
		container = undefined;
		root = undefined;
		vi.restoreAllMocks();
	});

	async function renderSection(
		overrides: Partial<ComponentProps<typeof ToolsRuntimeSection>> = {},
	) {
		const props = createProps(overrides);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(createElement(ToolsRuntimeSection, props));
			await flushAsyncWork(3);
		});

		return { props, container };
	}

	it("preserves auth preset secrets until replacement is explicitly enabled", async () => {
		const { props, container } = await renderSection();
		const updatePreset = props.onUpdateMcpAuthPreset as ReturnType<
			typeof vi.fn
		>;

		const saveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Save",
		) as HTMLButtonElement | undefined;
		expect(saveButton).toBeDefined();
		await act(async () => {
			saveButton?.click();
			await flushAsyncWork(3);
		});

		expect(updatePreset).toHaveBeenCalledTimes(1);
		const firstCall = updatePreset.mock.calls[0]?.[0];
		expect(firstCall.preset.name).toBe("linear-auth");
		expect(firstCall.preset.headers).toBeUndefined();
		expect(firstCall.preset.headersHelper).toBeUndefined();

		const replaceHeaders = container.querySelector(
			'input[aria-label="Replace hidden headers for auth preset linear-auth"]',
		) as HTMLInputElement | null;
		expect(replaceHeaders).not.toBeNull();
		await act(async () => {
			replaceHeaders!.checked = true;
			replaceHeaders!.dispatchEvent(new Event("change", { bubbles: true }));
			await flushAsyncWork(2);
		});

		await act(async () => {
			saveButton?.click();
			await flushAsyncWork(3);
		});

		expect(updatePreset).toHaveBeenCalledTimes(2);
		const secondCall = updatePreset.mock.calls[1]?.[0];
		expect(secondCall.preset.headers).toBeNull();
		expect(secondCall.preset.headersHelper).toBeUndefined();
	});

	it("clears stale MCP resource and prompt output when reruns fail", async () => {
		const readResource = vi
			.fn()
			.mockResolvedValueOnce({
				contents: [
					{
						uri: "linear://workspace",
						text: "workspace content",
						mimeType: "text/plain",
					},
				],
			})
			.mockRejectedValueOnce(new Error("Resource read failed"));
		const getPrompt = vi
			.fn()
			.mockResolvedValueOnce({
				description: "Summarize a Linear issue",
				messages: [
					{
						role: "user",
						content: "Summarize issue MAE-1",
					},
				],
			})
			.mockRejectedValueOnce(new Error("Prompt run failed"));
		const { container } = await renderSection({
			expandedMcpServer: "linear",
			onReadMcpResource: readResource,
			onGetMcpPrompt: getPrompt,
		});

		const readButton = container.querySelector(
			'button[aria-label="Read resource for linear"]',
		) as HTMLButtonElement | null;
		const promptButton = container.querySelector(
			'button[aria-label="Run prompt for linear"]',
		) as HTMLButtonElement | null;
		const promptArgumentInput = container.querySelector(
			'input[aria-label="Prompt argument ISSUE for linear"]',
		) as HTMLInputElement | null;
		expect(readButton).not.toBeNull();
		expect(promptButton).not.toBeNull();
		expect(promptArgumentInput).not.toBeNull();

		await act(async () => {
			readButton?.click();
			await flushAsyncWork(3);
		});
		expect(container.textContent ?? "").toContain("workspace content");

		await act(async () => {
			readButton?.click();
			await flushAsyncWork(3);
		});
		const afterReadFailure = container.textContent ?? "";
		expect(afterReadFailure).toContain("Resource read failed");
		expect(afterReadFailure).not.toContain("workspace content");

		await act(async () => {
			if (!promptArgumentInput) {
				throw new Error("Expected MCP prompt argument input");
			}
			promptArgumentInput.value = "MAE-1";
			promptArgumentInput.dispatchEvent(new Event("input", { bubbles: true }));
			await flushAsyncWork(1);
		});
		await act(async () => {
			promptButton?.click();
			await flushAsyncWork(3);
		});
		expect(container.textContent ?? "").toContain("Summarize issue MAE-1");

		await act(async () => {
			if (!promptArgumentInput) {
				throw new Error("Expected MCP prompt argument input");
			}
			promptArgumentInput.value = "MAE-1";
			promptArgumentInput.dispatchEvent(new Event("input", { bubbles: true }));
			await flushAsyncWork(1);
		});
		await act(async () => {
			promptButton?.click();
			await flushAsyncWork(3);
		});
		const afterPromptFailure = container.textContent ?? "";
		expect(afterPromptFailure).toContain("Prompt run failed");
		expect(afterPromptFailure).not.toContain("Summarize issue MAE-1");
	});

	it("runs MCP prompts from structured argument fields when metadata is available", async () => {
		const getPrompt = vi.fn().mockResolvedValue({
			description: "Summarize a Linear issue",
			messages: [
				{
					role: "user",
					content: "Summarize issue MAE-1",
				},
			],
		});
		const { container } = await renderSection({
			expandedMcpServer: "linear",
			onGetMcpPrompt: getPrompt,
		});

		const promptArgInput = container.querySelector(
			'input[aria-label="Prompt argument ISSUE for linear"]',
		) as HTMLInputElement | null;
		const legacyTextarea = container.querySelector(
			'textarea[aria-label="Prompt arguments for linear"]',
		);
		const promptButton = container.querySelector(
			'button[aria-label="Run prompt for linear"]',
		) as HTMLButtonElement | null;
		expect(promptArgInput).not.toBeNull();
		expect(legacyTextarea).toBeNull();
		expect(promptButton).not.toBeNull();

		await act(async () => {
			promptArgInput!.value = "MAE-1";
			promptArgInput!.dispatchEvent(new Event("input", { bubbles: true }));
			await flushAsyncWork(2);
		});

		await act(async () => {
			promptButton?.click();
			await flushAsyncWork(3);
		});

		expect(getPrompt).toHaveBeenCalledWith("linear", "summarize-issue", {
			ISSUE: "MAE-1",
		});
		expect(container.textContent ?? "").toContain("Summarize issue MAE-1");
	});
});
