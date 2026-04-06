import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-settings.js";
import type { ComposerSettings } from "./composer-settings.js";

function createApiClientMock(): ApiClient {
	return {
		getStatus: vi.fn().mockResolvedValue({
			cwd: "/repo",
			git: null,
			context: { agentMd: true, claudeMd: false },
			server: { uptime: 120, version: "v1.0.0" },
		}),
		getModels: vi.fn().mockResolvedValue([
			{
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				provider: "openai",
			},
		]),
		getUsage: vi.fn().mockResolvedValue({
			totalCost: 0,
			totalTokens: 0,
			totalRequests: 0,
			byProvider: {},
			byModel: {},
		}),
		getMcpStatus: vi.fn().mockResolvedValue({
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
					remoteTrust: "official",
					remoteHost: "mcp.linear.app",
					authPreset: "linear-auth",
					resources: ["linear://workspace"],
					prompts: ["summarize-issue"],
				},
			],
		}),
		readMcpResource: vi.fn().mockResolvedValue({
			contents: [
				{
					uri: "linear://workspace",
					text: "workspace content",
					mimeType: "text/plain",
				},
			],
		}),
		getMcpPrompt: vi.fn().mockResolvedValue({
			description: "Summarize a Linear issue",
			messages: [
				{
					role: "user",
					content: "Summarize issue MAE-1",
				},
			],
		}),
		searchMcpRegistry: vi.fn().mockResolvedValue({
			query: "",
			entries: [
				{
					displayName: "Linear",
					slug: "linear",
					oneLiner: "Track issues and projects.",
					transport: "http",
					authorName: "Linear",
					toolCount: 12,
					promptCount: 2,
					urlOptions: [
						{
							url: "https://mcp.linear.app/mcp",
							label: "Production",
						},
					],
				},
			],
		}),
		importMcpRegistry: vi.fn().mockResolvedValue({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.json",
			entry: {
				displayName: "Linear",
			},
			server: {
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		}),
		addMcpServer: vi.fn().mockResolvedValue({
			name: "custom-docs",
			scope: "local",
			path: "/repo/.maestro/mcp.json",
			server: {
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
			},
		}),
		addMcpAuthPreset: vi.fn().mockResolvedValue({
			name: "new-auth",
			scope: "local",
			path: "/repo/.maestro/mcp.json",
			preset: {
				name: "new-auth",
				headers: {
					Authorization: "Bearer token",
				},
			},
		}),
		updateMcpAuthPreset: vi.fn().mockResolvedValue({
			name: "linear-auth",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			preset: {
				name: "linear-auth",
				headersHelper: "bun run scripts/updated-headers.ts",
			},
		}),
		removeMcpAuthPreset: vi.fn().mockResolvedValue({
			name: "linear-auth",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			fallback: null,
		}),
		removeMcpServer: vi.fn().mockResolvedValue({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			fallback: null,
		}),
		updateMcpServer: vi.fn().mockResolvedValue({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
			},
		}),
	} as unknown as ApiClient;
}

function createSettings(apiClient: ApiClient): ComposerSettings {
	const element = document.createElement(
		"composer-settings",
	) as ComposerSettings;
	element.apiClient = apiClient;
	document.body.append(element);
	return element;
}

async function waitForSettled(
	element: ComposerSettings,
	predicate: () => boolean,
	attempts = 20,
) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await Promise.resolve();
		await element.updateComplete;
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for composer settings to settle");
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("ComposerSettings MCP section", () => {
	it("renders configured MCP servers and official registry results", async () => {
		const apiClient = createApiClientMock();
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes("Configured Servers"),
		);

		expect(apiClient.searchMcpRegistry).toHaveBeenCalledWith("");
		const text = element.shadowRoot?.textContent ?? "";
		expect(text).toContain("Configured Servers");
		expect(text).toContain("linear");
		expect(text).toContain("Official Registry");
		expect(text).toContain("Track issues and projects.");
		expect(text).toContain("Official remote");
		expect(text).toContain("Auth Presets");
		expect(text).toContain("linear-auth");
		expect(text).toContain("Auth preset: linear-auth");
	});

	it("reads MCP resources and runs MCP prompts from settings", async () => {
		const apiClient = createApiClientMock();
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'button[aria-label="Read resource for linear"]',
				),
			),
		);

		const readButton = element.shadowRoot?.querySelector(
			'button[aria-label="Read resource for linear"]',
		) as HTMLButtonElement | null;
		expect(readButton).not.toBeNull();
		readButton?.dispatchEvent(new Event("click", { bubbles: true }));

		await waitForSettled(
			element,
			() =>
				(apiClient.readMcpResource as ReturnType<typeof vi.fn>).mock.calls
					.length > 0,
		);

		expect(apiClient.readMcpResource).toHaveBeenCalledWith(
			"linear",
			"linear://workspace",
		);
		expect(element.shadowRoot?.textContent ?? "").toContain(
			"workspace content",
		);

		const promptArgs = element.shadowRoot?.querySelector(
			'textarea[aria-label="Prompt arguments for linear"]',
		) as HTMLTextAreaElement | null;
		expect(promptArgs).not.toBeNull();
		if (!promptArgs) {
			throw new Error("Expected MCP prompt arguments textarea");
		}
		promptArgs.value = "ISSUE=MAE-1";
		promptArgs.dispatchEvent(new Event("input", { bubbles: true }));

		const runButton = element.shadowRoot?.querySelector(
			'button[aria-label="Run prompt for linear"]',
		) as HTMLButtonElement | null;
		expect(runButton).not.toBeNull();
		runButton?.dispatchEvent(new Event("click", { bubbles: true }));

		await waitForSettled(
			element,
			() =>
				(apiClient.getMcpPrompt as ReturnType<typeof vi.fn>).mock.calls.length >
				0,
		);

		expect(apiClient.getMcpPrompt).toHaveBeenCalledWith(
			"linear",
			"summarize-issue",
			{
				ISSUE: "MAE-1",
			},
		);
		expect(element.shadowRoot?.textContent ?? "").toContain(
			"Summarize issue MAE-1",
		);
	});

	it("adds an MCP auth preset and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ authPresets: [], servers: [] })
			.mockResolvedValueOnce({
				authPresets: [
					{
						name: "new-auth",
						scope: "local",
						headerKeys: ["Authorization"],
					},
				],
				servers: [],
			});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(element.shadowRoot?.querySelector(".mcp-auth-preset-add-button")),
		);

		const nameInput = element.shadowRoot?.querySelector(
			'input[aria-label="MCP auth preset name"]',
		) as HTMLInputElement | null;
		const headersInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="MCP auth preset headers"]',
		) as HTMLTextAreaElement | null;
		expect(nameInput).not.toBeNull();
		expect(headersInput).not.toBeNull();
		if (!nameInput || !headersInput) {
			throw new Error("Expected auth preset inputs");
		}

		nameInput.value = "new-auth";
		nameInput.dispatchEvent(new Event("input", { bubbles: true }));
		headersInput.value = "Authorization=Bearer token";
		headersInput.dispatchEvent(new Event("input", { bubbles: true }));

		await waitForSettled(
			element,
			() => {
				const button = element.shadowRoot?.querySelector(
					".mcp-auth-preset-add-button",
				) as HTMLButtonElement | null;
				return Boolean(button && !button.disabled);
			},
			20,
		);

		const addButton = element.shadowRoot?.querySelector(
			".mcp-auth-preset-add-button",
		) as HTMLButtonElement | null;
		expect(addButton).not.toBeNull();
		addButton?.click();

		await waitForSettled(
			element,
			() =>
				(apiClient.addMcpAuthPreset as ReturnType<typeof vi.fn>).mock.calls
					.length > 0,
			30,
		);

		expect(apiClient.addMcpAuthPreset).toHaveBeenCalledWith({
			scope: "local",
			preset: {
				name: "new-auth",
				headers: {
					Authorization: "Bearer token",
				},
				headersHelper: null,
			},
		});
		expect(apiClient.getMcpStatus).toHaveBeenCalledTimes(2);
	});

	it("imports a registry entry and refreshes MCP status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ servers: [] })
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						transport: "http",
						remoteTrust: "official",
					},
				],
			});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(element.shadowRoot?.querySelector(".mcp-import-button")),
		);

		const button = element.shadowRoot?.querySelector(
			".mcp-import-button",
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Imported linear into Local config via HTTP.",
			),
		);

		expect(apiClient.importMcpRegistry).toHaveBeenCalledWith({
			query: "linear",
			name: undefined,
			scope: "local",
			url: "https://mcp.linear.app/mcp",
		});
		expect(apiClient.getMcpStatus).toHaveBeenCalledTimes(2);
		expect(element.shadowRoot?.textContent ?? "").toContain(
			"Imported linear into Local config via HTTP.",
		);
	});

	it("adds a custom remote MCP server and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				authPresets: [
					{
						name: "linear-auth",
						scope: "local",
						headerKeys: ["Authorization"],
					},
				],
				servers: [],
			})
			.mockResolvedValueOnce({
				authPresets: [
					{
						name: "linear-auth",
						scope: "local",
						headerKeys: ["Authorization"],
					},
				],
				servers: [
					{
						name: "custom-docs",
						connected: true,
						scope: "project",
						transport: "http",
						remoteTrust: "custom",
						authPreset: "linear-auth",
					},
				],
			});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(element.shadowRoot?.querySelector(".mcp-custom-add-button")),
		);

		const nameInput = element.shadowRoot?.querySelector(
			'input[placeholder="Server name"]',
		) as HTMLInputElement | null;
		const urlInput = element.shadowRoot?.querySelector(
			'input[placeholder="https://example.com/mcp"]',
		) as HTMLInputElement | null;
		const headersHelperInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server headers helper"]',
		) as HTMLInputElement | null;
		const authPresetSelect = element.shadowRoot?.querySelector(
			'select[aria-label="Custom MCP server auth preset"]',
		) as HTMLSelectElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server timeout"]',
		) as HTMLInputElement | null;
		expect(nameInput).not.toBeNull();
		expect(urlInput).not.toBeNull();
		expect(headersHelperInput).not.toBeNull();
		expect(authPresetSelect).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		if (
			!nameInput ||
			!urlInput ||
			!headersHelperInput ||
			!authPresetSelect ||
			!timeoutInput
		) {
			throw new Error("Expected MCP custom remote inputs");
		}
		nameInput.value = "custom-docs";
		nameInput.dispatchEvent(new Event("input", { bubbles: true }));
		urlInput.value = "https://docs.example.com/mcp";
		urlInput.dispatchEvent(new Event("input", { bubbles: true }));
		headersHelperInput.value = "bun run scripts/mcp-headers.ts";
		headersHelperInput.dispatchEvent(new Event("input", { bubbles: true }));
		authPresetSelect.value = "linear-auth";
		authPresetSelect.dispatchEvent(new Event("change", { bubbles: true }));
		timeoutInput.value = "15000";
		timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));
		await waitForSettled(
			element,
			() => {
				const button = element.shadowRoot?.querySelector(
					".mcp-custom-add-button",
				) as HTMLButtonElement | null;
				return Boolean(button && !button.disabled);
			},
			10,
		);

		const button = element.shadowRoot?.querySelector(
			".mcp-custom-add-button",
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Added custom-docs to Local config via HTTP.",
			),
		);

		expect(apiClient.addMcpServer).toHaveBeenCalledWith({
			scope: "local",
			server: {
				name: "custom-docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
				headersHelper: "bun run scripts/mcp-headers.ts",
				authPreset: "linear-auth",
				timeout: 15000,
			},
		});
		expect(element.shadowRoot?.textContent ?? "").toContain(
			"Added custom-docs to Local config via HTTP.",
		);
	});

	it("adds a custom stdio MCP server and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.addMcpServer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			name: "filesystem",
			scope: "local",
			path: "/repo/.maestro/mcp.json",
			server: {
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
				cwd: "/repo",
			},
		});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(element.shadowRoot?.querySelector(".mcp-custom-add-button")),
		);

		const nameInput = element.shadowRoot?.querySelector(
			'input[placeholder="Server name"]',
		) as HTMLInputElement | null;
		expect(nameInput).not.toBeNull();
		if (!nameInput) {
			throw new Error("Expected MCP custom server name input");
		}
		nameInput.value = "filesystem";
		nameInput.dispatchEvent(new Event("input", { bubbles: true }));

		const transportSelect = element.shadowRoot?.querySelector(
			'select[aria-label="Custom MCP server transport"]',
		) as HTMLSelectElement | null;
		expect(transportSelect).not.toBeNull();
		transportSelect!.value = "stdio";
		transportSelect!.dispatchEvent(new Event("change", { bubbles: true }));

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'input[aria-label="Custom MCP server command"]',
				),
			),
		);

		const commandInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server command"]',
		) as HTMLInputElement | null;
		const argsInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Custom MCP server arguments"]',
		) as HTMLTextAreaElement | null;
		const cwdInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server working directory"]',
		) as HTMLInputElement | null;
		const envInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Custom MCP server environment variables"]',
		) as HTMLTextAreaElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server timeout"]',
		) as HTMLInputElement | null;
		expect(commandInput).not.toBeNull();
		expect(argsInput).not.toBeNull();
		expect(cwdInput).not.toBeNull();
		expect(envInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		if (
			!commandInput ||
			!argsInput ||
			!cwdInput ||
			!envInput ||
			!timeoutInput
		) {
			throw new Error("Expected MCP custom stdio inputs");
		}

		commandInput.value = "npx";
		commandInput.dispatchEvent(new Event("input", { bubbles: true }));
		argsInput.value = "-y\n@modelcontextprotocol/server-filesystem\n/repo";
		argsInput.dispatchEvent(new Event("input", { bubbles: true }));
		cwdInput.value = "/repo";
		cwdInput.dispatchEvent(new Event("input", { bubbles: true }));
		envInput.value = "HOME=/Users/demo\nTOKEN=secret";
		envInput.dispatchEvent(new Event("input", { bubbles: true }));
		timeoutInput.value = "30000";
		timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));

		await waitForSettled(
			element,
			() => {
				const button = element.shadowRoot?.querySelector(
					".mcp-custom-add-button",
				) as HTMLButtonElement | null;
				return Boolean(button && !button.disabled);
			},
			10,
		);

		const button = element.shadowRoot?.querySelector(
			".mcp-custom-add-button",
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Added filesystem to Local config via stdio.",
			),
		);

		expect(apiClient.addMcpServer).toHaveBeenCalledWith({
			scope: "local",
			server: {
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
				cwd: "/repo",
				env: {
					HOME: "/Users/demo",
					TOKEN: "secret",
				},
				timeout: 30000,
			},
		});
	});

	it("removes a writable MCP server and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						scope: "local",
						transport: "http",
						remoteTrust: "official",
					},
				],
			})
			.mockResolvedValueOnce({ servers: [] });
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(element.shadowRoot?.querySelector(".mcp-remove-button")),
		);

		const button = element.shadowRoot?.querySelector(
			".mcp-remove-button",
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Removed linear from Local config.",
			),
		);

		expect(apiClient.removeMcpServer).toHaveBeenCalledWith({
			name: "linear",
			scope: "local",
		});
	});

	it("updates a writable MCP remote server and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						scope: "local",
						transport: "http",
						remoteTrust: "official",
						remoteUrl: "https://mcp.linear.app/mcp",
						headerKeys: ["Authorization"],
						headersHelper: "bun run scripts/mcp-headers.ts",
						timeout: 20000,
					},
				],
			})
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						scope: "local",
						transport: "sse",
						remoteTrust: "official",
						remoteUrl: "https://mcp.linear.app/sse",
						headersHelper: "bun run scripts/new-headers.ts",
						timeout: 15000,
					},
				],
			});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'input[aria-label="Remote URL for linear"]',
				),
			),
		);

		const urlInput = element.shadowRoot?.querySelector(
			'input[aria-label="Remote URL for linear"]',
		) as HTMLInputElement | null;
		expect(urlInput).not.toBeNull();
		if (!urlInput) {
			throw new Error("Expected MCP edit URL input");
		}
		urlInput.value = "https://mcp.linear.app/sse";
		urlInput.dispatchEvent(new Event("input", { bubbles: true }));

		const transportSelect = element.shadowRoot?.querySelector(
			'select[aria-label="Remote transport for linear"]',
		) as HTMLSelectElement | null;
		const headersHelperInput = element.shadowRoot?.querySelector(
			'input[aria-label="Headers helper for linear"]',
		) as HTMLInputElement | null;
		const headersInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Headers for linear"]',
		) as HTMLTextAreaElement | null;
		const replaceHeadersInput = element.shadowRoot?.querySelector(
			'input[aria-label="Replace hidden headers for linear"]',
		) as HTMLInputElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for linear"]',
		) as HTMLInputElement | null;
		expect(transportSelect).not.toBeNull();
		expect(headersHelperInput).not.toBeNull();
		expect(headersInput).not.toBeNull();
		expect(replaceHeadersInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		expect(headersInput?.disabled).toBe(true);
		transportSelect!.value = "sse";
		transportSelect!.dispatchEvent(new Event("change", { bubbles: true }));
		headersHelperInput!.value = "bun run scripts/new-headers.ts";
		headersHelperInput!.dispatchEvent(new Event("input", { bubbles: true }));
		replaceHeadersInput!.click();
		await waitForSettled(element, () => headersInput!.disabled === false);
		expect(headersInput!.disabled).toBe(false);
		headersInput!.value = "Authorization=Bearer token\nX-Org=acme";
		headersInput!.dispatchEvent(new Event("input", { bubbles: true }));
		timeoutInput!.value = "15000";
		timeoutInput!.dispatchEvent(new Event("input", { bubbles: true }));

		const button = element.shadowRoot?.querySelector(
			".mcp-update-button",
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Updated linear in Local config via SSE.",
			),
		);

		expect(apiClient.updateMcpServer).toHaveBeenCalledWith({
			name: "linear",
			scope: "local",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
				headers: {
					Authorization: "Bearer token",
					"X-Org": "acme",
				},
				headersHelper: "bun run scripts/new-headers.ts",
				authPreset: null,
				timeout: 15000,
			},
		});
	});

	it("updates a writable MCP stdio server and refreshes status", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				servers: [
					{
						name: "filesystem",
						connected: true,
						scope: "local",
						transport: "stdio",
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
						cwd: "/repo",
						envKeys: ["HOME", "TOKEN"],
						timeout: 30000,
					},
				],
			})
			.mockResolvedValueOnce({
				servers: [
					{
						name: "filesystem",
						connected: true,
						scope: "local",
						transport: "stdio",
						command: "bunx",
						args: [
							"-y",
							"@modelcontextprotocol/server-filesystem",
							"/workspace",
						],
						cwd: "/workspace",
						envKeys: ["HOME", "TOKEN"],
						timeout: 45000,
					},
				],
			});
		(
			apiClient.updateMcpServer as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			name: "filesystem",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "filesystem",
				transport: "stdio",
				command: "bunx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
				cwd: "/workspace",
				timeout: 45000,
			},
		});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'input[aria-label="Command for filesystem"]',
				),
			),
		);

		const commandInput = element.shadowRoot?.querySelector(
			'input[aria-label="Command for filesystem"]',
		) as HTMLInputElement | null;
		const argsInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Arguments for filesystem"]',
		) as HTMLTextAreaElement | null;
		const envInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Environment variables for filesystem"]',
		) as HTMLTextAreaElement | null;
		const replaceEnvInput = element.shadowRoot?.querySelector(
			'input[aria-label="Replace hidden environment variables for filesystem"]',
		) as HTMLInputElement | null;
		const cwdInput = element.shadowRoot?.querySelector(
			'input[aria-label="Working directory for filesystem"]',
		) as HTMLInputElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for filesystem"]',
		) as HTMLInputElement | null;
		expect(commandInput).not.toBeNull();
		expect(argsInput).not.toBeNull();
		expect(envInput).not.toBeNull();
		expect(replaceEnvInput).not.toBeNull();
		expect(cwdInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		if (
			!commandInput ||
			!argsInput ||
			!envInput ||
			!replaceEnvInput ||
			!cwdInput ||
			!timeoutInput
		) {
			throw new Error("Expected MCP stdio edit inputs");
		}

		commandInput.value = "bunx";
		commandInput.dispatchEvent(new Event("input", { bubbles: true }));
		argsInput.value = "-y\n@modelcontextprotocol/server-filesystem\n/workspace";
		argsInput.dispatchEvent(new Event("input", { bubbles: true }));
		expect(envInput.disabled).toBe(true);
		replaceEnvInput.click();
		await waitForSettled(element, () => envInput.disabled === false);
		expect(envInput.disabled).toBe(false);
		envInput.value = "HOME=/Users/demo\nTOKEN=rotated";
		envInput.dispatchEvent(new Event("input", { bubbles: true }));
		cwdInput.value = "/workspace";
		cwdInput.dispatchEvent(new Event("input", { bubbles: true }));
		timeoutInput.value = "45000";
		timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));

		const button = Array.from(
			element.shadowRoot?.querySelectorAll(".mcp-update-button") ?? [],
		)[0] as HTMLButtonElement | undefined;
		expect(button).toBeDefined();
		button?.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Updated filesystem in Local config via stdio.",
			),
		);

		expect(apiClient.updateMcpServer).toHaveBeenCalledWith({
			name: "filesystem",
			scope: "local",
			server: {
				name: "filesystem",
				transport: "stdio",
				command: "bunx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
				cwd: "/workspace",
				env: {
					HOME: "/Users/demo",
					TOKEN: "rotated",
				},
				timeout: 45000,
			},
		});
	});

	it("clears optional MCP remote edit fields when they are blanked", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						scope: "local",
						transport: "http",
						remoteTrust: "official",
						remoteUrl: "https://mcp.linear.app/mcp",
						headerKeys: ["Authorization"],
						headersHelper: "bun run scripts/mcp-headers.ts",
						timeout: 20000,
					},
				],
			})
			.mockResolvedValueOnce({
				servers: [
					{
						name: "linear",
						connected: true,
						scope: "local",
						transport: "http",
						remoteTrust: "official",
						remoteUrl: "https://mcp.linear.app/mcp",
					},
				],
			});
		(
			apiClient.updateMcpServer as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
			},
		});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'input[aria-label="Remote URL for linear"]',
				),
			),
		);

		const headersHelperInput = element.shadowRoot?.querySelector(
			'input[aria-label="Headers helper for linear"]',
		) as HTMLInputElement | null;
		const headersInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Headers for linear"]',
		) as HTMLTextAreaElement | null;
		const replaceHeadersInput = element.shadowRoot?.querySelector(
			'input[aria-label="Replace hidden headers for linear"]',
		) as HTMLInputElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for linear"]',
		) as HTMLInputElement | null;
		const button = element.shadowRoot?.querySelector(
			".mcp-update-button",
		) as HTMLButtonElement | null;
		expect(headersHelperInput).not.toBeNull();
		expect(headersInput).not.toBeNull();
		expect(replaceHeadersInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		expect(button).not.toBeNull();
		if (
			!headersHelperInput ||
			!headersInput ||
			!replaceHeadersInput ||
			!timeoutInput ||
			!button
		) {
			throw new Error("Expected MCP remote edit inputs");
		}

		headersHelperInput.value = "";
		headersHelperInput.dispatchEvent(new Event("input", { bubbles: true }));
		replaceHeadersInput.click();
		headersInput.value = "";
		headersInput.dispatchEvent(new Event("input", { bubbles: true }));
		timeoutInput.value = "";
		timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));
		button.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Updated linear in Local config via HTTP.",
			),
		);

		expect(apiClient.updateMcpServer).toHaveBeenCalledWith({
			name: "linear",
			scope: "local",
			server: {
				name: "linear",
				transport: "http",
				url: "https://mcp.linear.app/mcp",
				headers: null,
				headersHelper: null,
				authPreset: null,
				timeout: null,
			},
		});
	});

	it("preserves hidden remote headers unless replacement is enabled", async () => {
		const apiClient = createApiClientMock();
		(apiClient.getMcpStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
			servers: [
				{
					name: "linear",
					connected: true,
					scope: "local",
					transport: "http",
					remoteTrust: "official",
					remoteUrl: "https://mcp.linear.app/mcp",
					headerKeys: ["Authorization"],
					headersHelper: "bun run scripts/mcp-headers.ts",
					timeout: 20000,
				},
			],
		});
		(
			apiClient.updateMcpServer as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce({
			name: "linear",
			scope: "local",
			path: "/repo/.maestro/mcp.local.json",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
				headersHelper: "bun run scripts/mcp-headers.ts",
				timeout: 15000,
			},
		});
		const element = createSettings(apiClient);

		await waitForSettled(element, () =>
			Boolean(
				element.shadowRoot?.querySelector(
					'input[aria-label="Remote URL for linear"]',
				),
			),
		);

		const urlInput = element.shadowRoot?.querySelector(
			'input[aria-label="Remote URL for linear"]',
		) as HTMLInputElement | null;
		const transportSelect = element.shadowRoot?.querySelector(
			'select[aria-label="Remote transport for linear"]',
		) as HTMLSelectElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for linear"]',
		) as HTMLInputElement | null;
		const headersInput = element.shadowRoot?.querySelector(
			'textarea[aria-label="Headers for linear"]',
		) as HTMLTextAreaElement | null;
		const button = element.shadowRoot?.querySelector(
			".mcp-update-button",
		) as HTMLButtonElement | null;
		expect(urlInput).not.toBeNull();
		expect(transportSelect).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		expect(headersInput?.disabled).toBe(true);
		expect(button).not.toBeNull();
		if (!urlInput || !transportSelect || !timeoutInput || !button) {
			throw new Error("Expected MCP remote edit inputs");
		}

		urlInput.value = "https://mcp.linear.app/sse";
		urlInput.dispatchEvent(new Event("input", { bubbles: true }));
		transportSelect.value = "sse";
		transportSelect.dispatchEvent(new Event("change", { bubbles: true }));
		timeoutInput.value = "15000";
		timeoutInput.dispatchEvent(new Event("input", { bubbles: true }));
		button.click();

		await waitForSettled(element, () =>
			(element.shadowRoot?.textContent ?? "").includes(
				"Updated linear in Local config via SSE.",
			),
		);

		expect(apiClient.updateMcpServer).toHaveBeenCalledWith({
			name: "linear",
			scope: "local",
			server: {
				name: "linear",
				transport: "sse",
				url: "https://mcp.linear.app/sse",
				authPreset: null,
				timeout: 15000,
			},
		});
	});
});
