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
} from "../../src/lsp/index.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-integration-tests");
const FAKE_LSP_PATH = join(
	process.cwd(),
	"test",
	"fixture",
	"fake-lsp-server.cjs",
);
const DEFAULT_WAIT_MS = 1000;
const POLL_INTERVAL_MS = 25;

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = DEFAULT_WAIT_MS,
	intervalMs = POLL_INTERVAL_MS,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("Condition not met within timeout");
}

describe("LSP Integration Tests", () => {
	beforeEach(async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
		await configureServers([]);
	});

	afterEach(async () => {
		// Reset configuration which triggers shutdownAll internally
		await configureServers([]);
		await waitFor(async () => (await getClients()).length === 0, 500);
	});

	it("should spawn LSP server and initialize", async () => {
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		const config: LspServerConfig = {
			id: "fake-lsp",
			name: "Fake LSP Server",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
		};

		configureServers([config]);

		// Touch file to trigger LSP spawn and initialization
		await touchFile(testFile);

		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1 && clients[0]!.initialized;
		});

		const clients = await getClients();
		expect(clients.length).toBe(1);
		expect(clients[0]!.id).toBe("fake-lsp");
		expect(clients[0]!.initialized).toBe(true);
	}, 5000);

	it("should collect diagnostics from LSP server", async () => {
		const testFile = join(TEST_DIR, "error.ts");
		writeFileSync(testFile, "const x = error;"); // Contains "error"

		const config: LspServerConfig = {
			id: "fake-lsp-diag",
			name: "Fake LSP with Diagnostics",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
			env: { FAKE_LSP_DIAGNOSTICS: "1" },
		};

		configureServers([config]);

		await touchFile(testFile);

		await waitFor(async () => {
			const diagnostics = await collectDiagnostics();
			return Object.values(diagnostics).flat().length > 0;
		});

		const diagnostics = await collectDiagnostics();
		const allDiags = Object.values(diagnostics).flat();
		expect(allDiags.length).toBeGreaterThan(0);
		expect(allDiags[0]!.severity).toBe(1); // Error
		expect(allDiags[0]!.message).toContain("Test error");
	}, 5000);

	it("should track file changes with didChange", async () => {
		const testFile = join(TEST_DIR, "changing.ts");
		writeFileSync(testFile, "const x = 1;");

		const config: LspServerConfig = {
			id: "fake-lsp-change",
			name: "Fake LSP Change",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
			env: { FAKE_LSP_DIAGNOSTICS: "1" },
		};

		configureServers([config]);

		// Open file
		await touchFile(testFile);
		await waitFor(async () => {
			const diagnostics = await collectDiagnostics();
			return Object.values(diagnostics).flat().length === 0;
		});

		// Initially no errors
		let diagnostics = await collectDiagnostics();
		let allDiags = Object.values(diagnostics).flat();
		expect(allDiags.length).toBe(0);

		// Change to include error
		await changeFile(testFile, "const x = error;");
		await waitFor(async () => {
			const next = await collectDiagnostics();
			return Object.values(next).flat().length > 0;
		});

		// Should now have diagnostics
		diagnostics = await collectDiagnostics();
		allDiags = Object.values(diagnostics).flat();
		expect(allDiags.length).toBeGreaterThan(0);

		// Change back to valid
		await changeFile(testFile, "const x = 2;");
		await waitFor(async () => {
			const next = await collectDiagnostics();
			return Object.values(next).flat().length === 0;
		});

		// Diagnostics should clear
		diagnostics = await collectDiagnostics();
		allDiags = Object.values(diagnostics).flat();
		expect(allDiags.length).toBe(0);
	}, 8000);

	it("should search workspace symbols", async () => {
		const testFile = join(TEST_DIR, "symbols.ts");
		writeFileSync(testFile, "class MyClass {}");

		const config: LspServerConfig = {
			id: "fake-lsp-symbols",
			name: "Fake LSP Symbols",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
			env: { FAKE_LSP_SYMBOLS: "1" },
		};

		configureServers([config]);

		await touchFile(testFile);
		await waitFor(async () => (await workspaceSymbol("MyClass")).length > 0);

		const symbols = await workspaceSymbol("MyClass");
		expect(symbols.length).toBeGreaterThan(0);
		expect(symbols[0]!.name).toBe("MyClass");
		expect(symbols[0]!.kind).toBe(5); // Class
	}, 5000);

	it("should get document symbols", async () => {
		const testFile = join(TEST_DIR, "doc-symbols.ts");
		writeFileSync(testFile, "function test() {}\nclass Test {}");

		const config: LspServerConfig = {
			id: "fake-lsp-doc",
			name: "Fake LSP Doc",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
			env: { FAKE_LSP_SYMBOLS: "1" },
		};

		configureServers([config]);

		await touchFile(testFile);
		await waitFor(async () => {
			const symbols = await documentSymbol(testFile);
			return (
				symbols.some((s) => s.name === "testFunction") &&
				symbols.some((s) => s.name === "TestClass")
			);
		});

		const symbols = await documentSymbol(testFile);
		expect(symbols.length).toBeGreaterThan(0);

		const func = symbols.find((s) => s.name === "testFunction");
		const cls = symbols.find((s) => s.name === "TestClass");

		expect(func).toBeDefined();
		expect(cls).toBeDefined();
		expect(func?.kind).toBe(12); // Function
		expect(cls?.kind).toBe(5); // Class
	}, 5000);

	it("should handle file close", async () => {
		const testFile = join(TEST_DIR, "close-test.ts");
		writeFileSync(testFile, "const x = 1;");

		const config: LspServerConfig = {
			id: "fake-lsp-close",
			name: "Fake LSP Close",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
		};

		configureServers([config]);

		await touchFile(testFile);
		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1 && clients[0]!.openFiles.has(testFile);
		});

		const clientsBefore = await getClients();
		expect(clientsBefore.length).toBe(1);
		expect(clientsBefore[0]!.openFiles.has(testFile)).toBe(true);

		await closeFile(testFile);
		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1 && !clients[0]!.openFiles.has(testFile);
		});

		const clientsAfter = await getClients();
		expect(clientsAfter[0]!.openFiles.has(testFile)).toBe(false);
	}, 5000);

	it("should not spawn duplicate clients for same root", async () => {
		const file1 = join(TEST_DIR, "file1.ts");
		const file2 = join(TEST_DIR, "file2.ts");
		writeFileSync(file1, "const a = 1;");
		writeFileSync(file2, "const b = 2;");

		const config: LspServerConfig = {
			id: "fake-lsp-dup",
			name: "Fake LSP Dup",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts"],
		};

		configureServers([config]);

		await touchFile(file1);
		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1;
		});

		const clientsAfter1 = await getClients();
		expect(clientsAfter1.length).toBe(1);

		await touchFile(file2);
		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1 && clients[0]!.openFiles.size === 2;
		});

		const clientsAfter2 = await getClients();
		expect(clientsAfter2.length).toBe(1); // Still only 1 client
		expect(clientsAfter2[0]!.openFiles.size).toBe(2); // But tracking 2 files
	}, 5000);

	it("should handle multiple file extensions with one server", async () => {
		const tsFile = join(TEST_DIR, "test.ts");
		const jsFile = join(TEST_DIR, "test.js");
		writeFileSync(tsFile, "const x = 1;");
		writeFileSync(jsFile, "const y = 2;");

		const config: LspServerConfig = {
			id: "fake-lsp-multi",
			name: "Fake LSP Multi",
			command: process.execPath,
			args: [FAKE_LSP_PATH],
			extensions: [".ts", ".js"],
		};

		configureServers([config]);

		await touchFile(tsFile);
		await touchFile(jsFile);
		await waitFor(async () => {
			const clients = await getClients();
			return clients.length === 1 && clients[0]!.openFiles.size === 2;
		});

		const clients = await getClients();
		expect(clients.length).toBe(1);
		expect(clients[0]!.openFiles.size).toBe(2);
	}, 5000);

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
