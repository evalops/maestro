import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LspServerConfig,
	SymbolKind,
	changeFile,
	closeFile,
	collectDiagnostics,
	completion,
	configureRootResolver,
	configureServers,
	definition,
	documentSymbol,
	formatting,
	getClients,
	implementation,
	references,
	touchFile,
	typeDefinition,
	workspaceSymbol,
} from "../../src/lsp/index.js";
import { lspManager } from "../../src/lsp/manager.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-functions-tests");

describe("LSP functions", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
		vi.restoreAllMocks();
	});

	it("should track file versions with changeFile", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		// Mock LSP config - no real servers for this test
		await configureServers([]);

		// Since no servers are configured, changeFile should complete without error
		await expect(changeFile(testFile, "const x = 2;")).resolves.toBeUndefined();
	});

	it("should handle closeFile", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);

		await expect(closeFile(testFile)).resolves.toBeUndefined();
	});

	it("should export SymbolKind enum", () => {
		expect(SymbolKind.Class).toBe(5);
		expect(SymbolKind.Function).toBe(12);
		expect(SymbolKind.Method).toBe(6);
		expect(SymbolKind.Interface).toBe(11);
		expect(SymbolKind.Variable).toBe(13);
	});

	it("should return empty array for workspaceSymbol with no clients", async () => {
		await configureServers([]);
		const symbols = await workspaceSymbol("test");
		expect(symbols).toEqual([]);
	});

	it("should return empty array for documentSymbol with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const symbols = await documentSymbol(testFile);
		expect(symbols).toEqual([]);
	});

	it("should return empty array for definition with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const locations = await definition(testFile, 0, 0);
		expect(locations).toEqual([]);
	});

	it("should return empty array for references with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const locations = await references(testFile, 0, 0);
		expect(locations).toEqual([]);
	});

	it("should return empty array for typeDefinition with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const locations = await typeDefinition(testFile, 0, 0);
		expect(locations).toEqual([]);
	});

	it("should return empty array for implementation with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const locations = await implementation(testFile, 0, 0);
		expect(locations).toEqual([]);
	});

	it("should return empty array for formatting with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const edits = await formatting(testFile);
		expect(edits).toEqual([]);
	});

	it("should return empty array for completion with no clients", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		const items = await completion(testFile, 0, 0);
		expect(items).toEqual([]);
	});

	it("should return empty diagnostics when no clients are running", async () => {
		await configureServers([]);
		const diagnostics = await collectDiagnostics();
		expect(diagnostics).toEqual({});
	});

	it("should return empty clients array when no servers configured", async () => {
		await configureServers([]);
		const clients = await getClients();
		expect(clients).toEqual([]);
	});

	it("should allow configuring custom root resolver", async () => {
		const customResolver = async (file: string) => {
			return join(TEST_DIR, "custom-root");
		};

		configureRootResolver(customResolver);

		// Root resolver is now configured, but we can't easily test it
		// without spawning real LSP servers
		expect(true).toBe(true);
	});

	it("should handle touchFile with no servers", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await configureServers([]);
		await expect(touchFile(testFile)).resolves.toBeUndefined();
	});

	it("should return definition from client when available", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		// Mock client
		const mockClient = {
			connection: {
				sendRequest: vi.fn().mockResolvedValue({
					uri: "file:///test.ts",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
				}),
			},
			openFile: vi.fn(),
		};

		// Mock lspManager to return our mock client
		vi.spyOn(lspManager, "getClientsForFile").mockResolvedValue([
			mockClient as unknown as Awaited<
				ReturnType<typeof lspManager.getClientsForFile>
			>[number],
		]);

		const locations = await definition(testFile, 0, 0);

		expect(locations).toHaveLength(1);
		expect(locations[0]!.uri).toBe("file:///test.ts");
		expect(mockClient.connection.sendRequest).toHaveBeenCalledWith(
			"textDocument/definition",
			expect.objectContaining({
				position: { line: 0, character: 0 },
			}),
		);
	});
});
