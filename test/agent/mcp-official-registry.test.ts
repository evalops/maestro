import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClientManager } from "../../src/mcp/manager.js";
import {
	buildSuggestedMcpServerName,
	getMcpRemoteHost,
	getOfficialMcpRegistryEntries,
	getOfficialMcpRegistryMatch,
	normalizeMcpRemoteUrl,
	prefetchOfficialMcpRegistry,
	resetOfficialMcpRegistryCacheForTesting,
	resolveOfficialMcpRegistryEntry,
	searchOfficialMcpRegistry,
	setOfficialMcpRegistryCacheForTesting,
} from "../../src/mcp/official-registry.js";

const mockRegistryPayload = {
	servers: [
		{
			server: {
				name: "example/query-remote",
				title: "Query Remote",
				remotes: [
					{
						type: "http",
						url: "https://registry.example.com/mcp?mode=full",
					},
				],
			},
			_meta: {
				"com.anthropic.api/mcp-registry": {
					displayName: "Query Remote",
					slug: "query-remote",
					oneLiner: "Run remote data queries",
					documentation: "https://docs.example.com/query",
					directoryUrl: "https://claude.ai/directory/query-remote",
					permissions: "Read and write",
					url: "https://registry.example.com/mcp?mode=full",
					author: { name: "Example Co" },
					toolNames: ["query", "search"],
					promptNames: ["summarize"],
				},
			},
		},
		{
			server: {
				name: "example/regional-remote",
				title: "Regional Remote",
				remotes: [{ type: "http", url: "{url}" }],
			},
			_meta: {
				"com.anthropic.api/mcp-registry": {
					displayName: "Regional Remote",
					slug: "regional-remote",
					permissions: "Read",
					urlOptions: [
						{ url: "https://eu.example.com/mcp" },
						{ url: "https://us.example.com/mcp" },
					],
				},
			},
		},
		{
			server: {
				name: "example/regex-remote",
				title: "Regex Remote",
				remotes: [{ type: "sse", url: "{url}" }],
			},
			_meta: {
				"com.anthropic.api/mcp-registry": {
					displayName: "Regex Remote",
					slug: "regex-remote",
					urlRegex: "https://mcp(\\.eu|\\.us)?\\.port\\.io/v1",
				},
			},
		},
	],
};

describe("official MCP registry", () => {
	afterEach(() => {
		resetOfficialMcpRegistryCacheForTesting();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("normalizes remote URLs for trust matching", () => {
		expect(
			normalizeMcpRemoteUrl("https://registry.example.com/mcp/?mode=full#frag"),
		).toBe("https://registry.example.com/mcp");
		expect(getMcpRemoteHost("https://registry.example.com/mcp?mode=full")).toBe(
			"registry.example.com",
		);
	});

	it("matches official servers by exact URL, urlOptions, and regex", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify(mockRegistryPayload), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);

		await prefetchOfficialMcpRegistry();

		expect(
			getOfficialMcpRegistryMatch("https://registry.example.com/mcp"),
		).toMatchObject({
			trust: "official",
			info: {
				displayName: "Query Remote",
				documentationUrl: "https://docs.example.com/query",
				permissions: "Read and write",
			},
		});

		expect(
			getOfficialMcpRegistryMatch("https://eu.example.com/mcp?region=eu"),
		).toMatchObject({
			trust: "official",
			info: {
				displayName: "Regional Remote",
				permissions: "Read",
			},
		});

		expect(
			getOfficialMcpRegistryMatch("https://mcp.eu.port.io/v1"),
		).toMatchObject({
			trust: "official",
			info: {
				displayName: "Regex Remote",
			},
		});

		expect(
			getOfficialMcpRegistryMatch("https://custom.example.com/mcp"),
		).toEqual({
			trust: "custom",
		});
	});

	it("exposes searchable official registry entries", () => {
		setOfficialMcpRegistryCacheForTesting(mockRegistryPayload);

		expect(getOfficialMcpRegistryEntries()).toEqual([
			expect.objectContaining({
				displayName: "Query Remote",
				slug: "query-remote",
				serverName: "example/query-remote",
				toolCount: 2,
				promptCount: 1,
			}),
			expect.objectContaining({
				displayName: "Regex Remote",
				slug: "regex-remote",
				transport: "sse",
			}),
			expect.objectContaining({
				displayName: "Regional Remote",
				slug: "regional-remote",
				urlOptions: [
					expect.objectContaining({ url: "https://eu.example.com/mcp" }),
					expect.objectContaining({ url: "https://us.example.com/mcp" }),
				],
			}),
		]);

		expect(searchOfficialMcpRegistry("query remote")).toEqual([
			expect.objectContaining({
				displayName: "Query Remote",
				slug: "query-remote",
			}),
		]);

		expect(resolveOfficialMcpRegistryEntry("query-remote")).toEqual({
			entry: expect.objectContaining({
				displayName: "Query Remote",
				slug: "query-remote",
			}),
			matches: [
				expect.objectContaining({
					displayName: "Query Remote",
					slug: "query-remote",
				}),
			],
		});

		expect(
			buildSuggestedMcpServerName({
				slug: "query-remote",
				displayName: "Query Remote",
				serverName: "example/query-remote",
			}),
		).toBe("query-remote");
	});

	it("returns unknown trust before the registry cache is loaded", () => {
		expect(
			getOfficialMcpRegistryMatch("https://custom.example.com/mcp"),
		).toEqual({
			trust: "unknown",
		});
	});

	it("enriches remote MCP status from the official registry cache", () => {
		setOfficialMcpRegistryCacheForTesting(mockRegistryPayload);

		const manager = new McpClientManager();
		(
			manager as unknown as {
				config: {
					servers: Array<{
						name: string;
						transport: "http";
						url: string;
						scope: "project";
					}>;
				};
			}
		).config = {
			servers: [
				{
					name: "query-remote",
					transport: "http",
					url: "https://registry.example.com/mcp?mode=full",
					scope: "project",
				},
			],
		};

		expect(manager.getStatus()).toEqual({
			authPresets: [],
			servers: [
				expect.objectContaining({
					name: "query-remote",
					connected: false,
					scope: "project",
					transport: "http",
					remoteUrl: "https://registry.example.com/mcp?mode=full",
					remoteHost: "registry.example.com",
					remoteTrust: "official",
					officialRegistry: expect.objectContaining({
						displayName: "Query Remote",
						documentationUrl: "https://docs.example.com/query",
						permissions: "Read and write",
						authorName: "Example Co",
					}),
				}),
			],
		});
	});
});
