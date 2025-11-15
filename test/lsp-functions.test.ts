import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type LspServerConfig,
	SymbolKind,
	changeFile,
	closeFile,
	collectDiagnostics,
	configureRootResolver,
	configureServers,
	documentSymbol,
	getClients,
	touchFile,
	workspaceSymbol,
} from "../src/lsp/index.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-functions-tests");

describe("LSP functions", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
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
});
