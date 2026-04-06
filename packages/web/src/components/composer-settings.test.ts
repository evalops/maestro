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
			servers: [
				{
					name: "linear",
					connected: true,
					scope: "local",
					transport: "http",
					remoteTrust: "official",
					remoteHost: "mcp.linear.app",
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
			.mockResolvedValueOnce({ servers: [] })
			.mockResolvedValueOnce({
				servers: [
					{
						name: "custom-docs",
						connected: true,
						scope: "project",
						transport: "http",
						remoteTrust: "custom",
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
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Custom MCP server timeout"]',
		) as HTMLInputElement | null;
		expect(nameInput).not.toBeNull();
		expect(urlInput).not.toBeNull();
		expect(headersHelperInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		if (!nameInput || !urlInput || !headersHelperInput || !timeoutInput) {
			throw new Error("Expected MCP custom remote inputs");
		}
		nameInput.value = "custom-docs";
		nameInput.dispatchEvent(new Event("input", { bubbles: true }));
		urlInput.value = "https://docs.example.com/mcp";
		urlInput.dispatchEvent(new Event("input", { bubbles: true }));
		headersHelperInput.value = "bun run scripts/mcp-headers.ts";
		headersHelperInput.dispatchEvent(new Event("input", { bubbles: true }));
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
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for linear"]',
		) as HTMLInputElement | null;
		expect(transportSelect).not.toBeNull();
		expect(headersHelperInput).not.toBeNull();
		expect(headersInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		transportSelect!.value = "sse";
		transportSelect!.dispatchEvent(new Event("change", { bubbles: true }));
		headersHelperInput!.value = "bun run scripts/new-headers.ts";
		headersHelperInput!.dispatchEvent(new Event("input", { bubbles: true }));
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
		const cwdInput = element.shadowRoot?.querySelector(
			'input[aria-label="Working directory for filesystem"]',
		) as HTMLInputElement | null;
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for filesystem"]',
		) as HTMLInputElement | null;
		expect(commandInput).not.toBeNull();
		expect(argsInput).not.toBeNull();
		expect(envInput).not.toBeNull();
		expect(cwdInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		if (
			!commandInput ||
			!argsInput ||
			!envInput ||
			!cwdInput ||
			!timeoutInput
		) {
			throw new Error("Expected MCP stdio edit inputs");
		}

		commandInput.value = "bunx";
		commandInput.dispatchEvent(new Event("input", { bubbles: true }));
		argsInput.value = "-y\n@modelcontextprotocol/server-filesystem\n/workspace";
		argsInput.dispatchEvent(new Event("input", { bubbles: true }));
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
		const timeoutInput = element.shadowRoot?.querySelector(
			'input[aria-label="Timeout for linear"]',
		) as HTMLInputElement | null;
		const button = element.shadowRoot?.querySelector(
			".mcp-update-button",
		) as HTMLButtonElement | null;
		expect(headersHelperInput).not.toBeNull();
		expect(headersInput).not.toBeNull();
		expect(timeoutInput).not.toBeNull();
		expect(button).not.toBeNull();
		if (!headersHelperInput || !headersInput || !timeoutInput || !button) {
			throw new Error("Expected MCP remote edit inputs");
		}

		headersHelperInput.value = "";
		headersHelperInput.dispatchEvent(new Event("input", { bubbles: true }));
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
				timeout: null,
			},
		});
	});
});
