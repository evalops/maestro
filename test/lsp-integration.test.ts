import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type LspServerConfig,
	changeFile,
	closeFile,
	collectDiagnostics,
	configureServers,
	documentSymbol,
	getClients,
	touchFile,
	workspaceSymbol,
} from "../src/lsp/index.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-integration-tests");
const FAKE_LSP_PATH = join(
	process.cwd(),
	"test",
	"fixture",
	"fake-lsp-server.cjs",
);

describe("LSP Integration Tests", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		// Clean up any running LSP clients
		const clients = await getClients();
		for (const client of clients) {
			try {
				client.process.kill("SIGKILL");
				client.connection.dispose();
			} catch {
				// Ignore
			}
		}
		// Reset configuration
		configureServers([]);
		// Allow cleanup time
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	it("should configure LSP servers", () => {
		const config: LspServerConfig = {
			id: "fake-lsp",
			name: "Fake LSP Server",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
		};

		// Should not throw when configuring
		configureServers([config]);
		configureServers([]);

		expect(true).toBe(true);
	});

	it("should collect diagnostics returns empty when no clients", async () => {
		configureServers([]);

		const diagnostics = await collectDiagnostics();
		expect(diagnostics).toEqual({});
	}, 1000);

	it("should track file changes without errors", async () => {
		const testFile = join(TEST_DIR, "changing.ts");
		writeFileSync(testFile, "const x = 1;");

		configureServers([]);

		// Test that changeFile works without crashing
		await changeFile(testFile, "const x = 2;");
		await changeFile(testFile, "const x = 3;");

		// No errors means success
		expect(true).toBe(true);
	}, 2000);

	it("should handle workspace symbol search with no clients", async () => {
		configureServers([]);

		const symbols = await workspaceSymbol("MyClass");
		expect(symbols).toEqual([]);
	}, 1000);

	it("should handle document symbol requests with no clients", async () => {
		const testFile = join(TEST_DIR, "doc-symbols.ts");
		writeFileSync(testFile, "function test() {}\nclass Test {}");

		configureServers([]);

		const symbols = await documentSymbol(testFile);
		expect(symbols).toEqual([]);
	}, 1000);

	it("should handle file close without errors", async () => {
		const testFile = join(TEST_DIR, "close-test.ts");
		writeFileSync(testFile, "const x = 1;");

		configureServers([]);

		// Should not throw even when file wasn't opened
		await expect(closeFile(testFile)).resolves.toBeUndefined();
	}, 1000);

	it("should handle multiple touchFile calls", async () => {
		const file1 = join(TEST_DIR, "file1.ts");
		const file2 = join(TEST_DIR, "file2.ts");
		writeFileSync(file1, "const a = 1;");
		writeFileSync(file2, "const b = 2;");

		configureServers([]);

		// Should handle multiple files without errors
		await touchFile(file1);
		await touchFile(file2);

		expect(true).toBe(true);
	}, 2000);

	it("should handle different file extensions", async () => {
		const tsFile = join(TEST_DIR, "test.ts");
		const jsFile = join(TEST_DIR, "test.js");
		const pyFile = join(TEST_DIR, "test.py");
		writeFileSync(tsFile, "const x = 1;");
		writeFileSync(jsFile, "const y = 2;");
		writeFileSync(pyFile, "z = 3");

		configureServers([]);

		// Should handle various file types
		await touchFile(tsFile);
		await touchFile(jsFile);
		await touchFile(pyFile);

		expect(true).toBe(true);
	}, 2000);

	it("should recover when LSP server fails to start", async () => {
		const testFile = join(TEST_DIR, "fail-test.ts");
		writeFileSync(testFile, "const x = 1;");

		const config: LspServerConfig = {
			id: "fake-lsp-fail",
			name: "Fake LSP that Fails",
			command: "/nonexistent/lsp/server",
			args: [],
			extensions: [".ts"],
		};

		configureServers([config]);

		// This should not throw, just fail gracefully
		await expect(touchFile(testFile)).resolves.toBeUndefined();

		const clients = await getClients();
		expect(clients.length).toBe(0);

		// Second attempt should also not spawn (marked as broken)
		await expect(touchFile(testFile)).resolves.toBeUndefined();
	}, 10000);
});
