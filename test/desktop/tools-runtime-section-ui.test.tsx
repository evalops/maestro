// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsRuntimeSection } from "../../packages/desktop/src/renderer/components/Settings/ToolsRuntimeSection";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function setTextControlValue(
	control: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) {
	const prototype =
		control instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
	descriptor?.set?.call(control, value);
	const inputEvent =
		typeof InputEvent === "function"
			? new InputEvent("input", { bubbles: true, data: value })
			: new Event("input", { bubbles: true });
	control.dispatchEvent(inputEvent);
	control.dispatchEvent(new Event("change", { bubbles: true }));
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
		onSetMcpProjectApproval: vi.fn().mockResolvedValue({
			name: "linear",
			scope: "project",
			decision: "approved",
			projectApproval: "approved",
		}),
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
		packageStatus: {
			packages: [
				{
					scope: "project",
					configPath: "/repo/.maestro/config.toml",
					sourceSpec: "./packages/example",
					filters: null,
					inspection: {
						sourceSpec: "./packages/example",
						resolvedSource: "./packages/example",
						sourceType: "local",
						resolvedPath: "/repo/packages/example",
						discovered: {
							name: "@acme/example",
							version: "1.0.0",
							isMaestroPackage: true,
							hasManifest: true,
							manifestPaths: {
								skills: ["tooling"],
							},
							errors: [],
						},
						resources: {
							extensions: [],
							skills: ["tooling"],
							prompts: [],
							themes: [],
						},
					},
					issues: [],
					error: null,
				},
			],
		},
		onRefreshPackageStatus: vi.fn(),
		onInspectPackage: vi.fn().mockResolvedValue({
			inspection: {
				sourceSpec: "./packages/example",
				resolvedSource: "./packages/example",
				sourceType: "local",
				resolvedPath: "/repo/packages/example",
				discovered: {
					name: "@acme/example",
					version: "1.0.0",
					isMaestroPackage: true,
					hasManifest: true,
					manifestPaths: {
						skills: ["tooling"],
					},
					errors: [],
				},
				resources: {
					extensions: [],
					skills: ["tooling"],
					prompts: [],
					themes: [],
				},
			},
			issues: [],
		}),
		onRefreshPackage: vi.fn().mockResolvedValue({
			inspection: {
				sourceSpec: "./packages/example",
				resolvedSource: "./packages/example",
				sourceType: "local",
				resolvedPath: "/repo/packages/example",
				discovered: {
					name: "@acme/example",
					version: "1.0.1",
					isMaestroPackage: true,
					hasManifest: true,
					manifestPaths: {
						skills: ["tooling"],
					},
					errors: [],
				},
				resources: {
					extensions: [],
					skills: ["tooling", "deploy"],
					prompts: [],
					themes: [],
				},
			},
			issues: [],
		}),
		onRefreshAllPackages: vi.fn().mockResolvedValue({
			refreshed: [
				{
					source: "git:github.com/acme/example@main",
					sourceType: "git",
					scopes: ["project"],
					inspection: {
						sourceSpec: "git:github.com/acme/example@main",
						resolvedSource: "git:github.com/acme/example@main",
						sourceType: "git",
						resolvedPath: "/repo/.maestro/packages/git-1234",
						discovered: {
							name: "@acme/example",
							version: "1.0.1",
							isMaestroPackage: true,
							hasManifest: true,
							manifestPaths: {
								skills: ["tooling"],
							},
							errors: [],
						},
						resources: {
							extensions: [],
							skills: ["tooling", "deploy"],
							prompts: [],
							themes: [],
						},
					},
					issues: [],
					error: null,
				},
			],
			localCount: 1,
			remoteCount: 1,
		}),
		onPrunePackageCache: vi.fn().mockResolvedValue({
			cacheDir: "/repo/.maestro/packages",
			removed: ["/repo/.maestro/packages/git-deadbeef"],
			removedCount: 1,
			referencedCount: 1,
		}),
		onValidatePackage: vi.fn().mockResolvedValue({
			inspection: {
				sourceSpec: "./packages/example",
				resolvedSource: "./packages/example",
				sourceType: "local",
				resolvedPath: "/repo/packages/example",
				discovered: {
					name: "@acme/example",
					version: "1.0.0",
					isMaestroPackage: true,
					hasManifest: true,
					manifestPaths: {
						skills: ["tooling"],
					},
					errors: [],
				},
				resources: {
					extensions: [],
					skills: ["tooling"],
					prompts: [],
					themes: [],
				},
			},
			issues: [],
		}),
		onAddPackage: vi.fn().mockResolvedValue({
			path: "/repo/.maestro/config.toml",
			scope: "project",
			spec: "./packages/example",
		}),
		onRemovePackage: vi.fn().mockResolvedValue({
			path: "/repo/.maestro/config.toml",
			scope: "project",
			removedCount: 1,
			fallback: null,
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
			replaceHeaders?.click();
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

		const readButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Read resource",
		) as HTMLButtonElement | undefined;
		const promptButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Run prompt",
		) as HTMLButtonElement | undefined;
		const promptArgumentInput = container.querySelector(
			'input[aria-label="Prompt argument ISSUE for linear"]',
		) as HTMLInputElement | null;
		expect(readButton).toBeDefined();
		expect(promptButton).toBeDefined();
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
			setTextControlValue(promptArgumentInput, "MAE-1");
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
			setTextControlValue(promptArgumentInput, "MAE-1");
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
		const promptButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Run prompt",
		) as HTMLButtonElement | undefined;
		expect(promptArgInput).not.toBeNull();
		expect(legacyTextarea).toBeNull();
		expect(promptButton).toBeDefined();

		await act(async () => {
			setTextControlValue(promptArgInput!, "MAE-1");
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

	it("approves pending project MCP servers from the settings panel", async () => {
		const { container, props } = await renderSection({
			expandedMcpServer: "linear",
			mcpStatus: {
				authPresets: [],
				servers: [
					{
						name: "linear",
						connected: false,
						scope: "project",
						transport: "http",
						projectApproval: "pending",
						resources: [],
						prompts: [],
					},
				],
			},
		});

		const approveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Approve",
		) as HTMLButtonElement | undefined;
		expect(approveButton).toBeDefined();

		await act(async () => {
			approveButton?.click();
			await flushAsyncWork(3);
		});

		expect(props.onSetMcpProjectApproval).toHaveBeenCalledWith({
			name: "linear",
			decision: "approved",
		});
	});

	it("refreshes configured git packages from the settings panel", async () => {
		const onRefreshPackage = vi.fn().mockResolvedValue({
			inspection: {
				sourceSpec: "git:github.com/acme/example@main",
				resolvedSource: "git:github.com/acme/example@main",
				sourceType: "git",
				resolvedPath: "/repo/.maestro/packages/git-1234",
				discovered: {
					name: "@acme/example",
					version: "1.0.1",
					isMaestroPackage: true,
					hasManifest: true,
					manifestPaths: {
						skills: ["tooling"],
					},
					errors: [],
				},
				resources: {
					extensions: [],
					skills: ["tooling", "deploy"],
					prompts: [],
					themes: [],
				},
			},
			issues: [],
		});
		const { container } = await renderSection({
			packageStatus: {
				packages: [
					{
						scope: "project",
						configPath: "/repo/.maestro/config.toml",
						sourceSpec: "git:github.com/acme/example@main",
						filters: null,
						inspection: {
							sourceSpec: "git:github.com/acme/example@main",
							resolvedSource: "git:github.com/acme/example@main",
							sourceType: "git",
							resolvedPath: "/repo/.maestro/packages/git-1234",
							discovered: {
								name: "@acme/example",
								version: "1.0.0",
								isMaestroPackage: true,
								hasManifest: true,
								manifestPaths: {
									skills: ["tooling"],
								},
								errors: [],
							},
							resources: {
								extensions: [],
								skills: ["tooling"],
								prompts: [],
								themes: [],
							},
						},
						issues: [],
						error: null,
					},
				],
			},
			onRefreshPackage,
		});

		const refreshButton = container.querySelector(
			".package-refresh-button",
		) as HTMLButtonElement | null;
		expect(refreshButton).toBeDefined();

		await act(async () => {
			refreshButton?.click();
			await flushAsyncWork(3);
		});

		expect(onRefreshPackage).toHaveBeenCalledWith(
			"git:github.com/acme/example@main",
		);
		expect(container.textContent ?? "").toContain(
			'Refreshed configured package "git:github.com/acme/example@main" from Project config.',
		);
	});

	it("refreshes all configured remote packages from the settings panel", async () => {
		const onRefreshAllPackages = vi.fn().mockResolvedValue({
			refreshed: [
				{
					source: "git:github.com/acme/example@main",
					sourceType: "git",
					scopes: ["project"],
					inspection: {
						sourceSpec: "git:github.com/acme/example@main",
						resolvedSource: "git:github.com/acme/example@main",
						sourceType: "git",
						resolvedPath: "/repo/.maestro/packages/git-1234",
						discovered: {
							name: "@acme/example",
							version: "1.0.1",
							isMaestroPackage: true,
							hasManifest: true,
							manifestPaths: {
								skills: ["tooling"],
							},
							errors: [],
						},
						resources: {
							extensions: [],
							skills: ["tooling", "deploy"],
							prompts: [],
							themes: [],
						},
					},
					issues: [],
					error: null,
				},
			],
			localCount: 1,
			remoteCount: 1,
		});

		await renderSection({
			packageStatus: {
				packages: [
					{
						scope: "project",
						configPath: "/repo/.maestro/config.toml",
						sourceSpec: "./packages/example",
						filters: null,
						inspection: {
							sourceSpec: "./packages/example",
							resolvedSource: "./packages/example",
							sourceType: "local",
							resolvedPath: "/repo/packages/example",
							discovered: {
								name: "@acme/example",
								version: "1.0.0",
								isMaestroPackage: true,
								hasManifest: true,
								manifestPaths: {
									skills: ["tooling"],
								},
								errors: [],
							},
							resources: {
								extensions: [],
								skills: ["tooling"],
								prompts: [],
								themes: [],
							},
						},
						issues: [],
						error: null,
					},
					{
						scope: "project",
						configPath: "/repo/.maestro/config.toml",
						sourceSpec: "git:github.com/acme/example@main",
						filters: null,
						inspection: {
							sourceSpec: "git:github.com/acme/example@main",
							resolvedSource: "git:github.com/acme/example@main",
							sourceType: "git",
							resolvedPath: "/repo/.maestro/packages/git-1234",
							discovered: {
								name: "@acme/example",
								version: "1.0.0",
								isMaestroPackage: true,
								hasManifest: true,
								manifestPaths: {
									skills: ["tooling"],
								},
								errors: [],
							},
							resources: {
								extensions: [],
								skills: ["tooling"],
								prompts: [],
								themes: [],
							},
						},
						issues: [],
						error: null,
					},
				],
			},
			onRefreshAllPackages,
		});

		const refreshButton = container.querySelector(
			".package-refresh-all-button",
		) as HTMLButtonElement | null;
		expect(refreshButton).toBeTruthy();

		await act(async () => {
			refreshButton?.click();
			await flushAsyncWork(3);
		});

		expect(onRefreshAllPackages).toHaveBeenCalledTimes(1);
		expect(container.textContent ?? "").toContain(
			"Refreshed 1 configured remote packages.",
		);
	});

	it("prunes unconfigured remote package caches from the settings panel", async () => {
		const onPrunePackageCache = vi.fn().mockResolvedValue({
			cacheDir: "/repo/.maestro/packages",
			removed: ["/repo/.maestro/packages/git-deadbeef"],
			removedCount: 1,
			referencedCount: 1,
		});

		const { container } = await renderSection({
			onPrunePackageCache,
		});

		const pruneButton = container.querySelector(
			".package-prune-cache-button",
		) as HTMLButtonElement | null;
		expect(pruneButton).toBeTruthy();

		await act(async () => {
			pruneButton?.click();
			await flushAsyncWork(3);
		});

		expect(onPrunePackageCache).toHaveBeenCalledTimes(1);
		expect(container.textContent ?? "").toContain(
			"Pruned 1 unconfigured remote package caches.",
		);
	});
});
