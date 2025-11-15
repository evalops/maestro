import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
	hover,
	touchFile,
	workspaceSymbol,
} from "../src/lsp/index.js";
import { languageIdFromFile } from "../src/lsp/language.js";

const TEST_DIR = join(process.cwd(), "tmp", "lsp-edge-cases-tests");

describe("LSP Edge Cases", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		const clients = await getClients();
		for (const client of clients) {
			try {
				client.process.kill();
			} catch {
				// Ignore
			}
		}
		configureServers([]);
	});

	it("should handle touchFile on non-existent file", async () => {
		configureServers([]);
		const nonExistent = join(TEST_DIR, "non-existent.ts");
		await expect(touchFile(nonExistent)).resolves.toBeUndefined();
	});

	it("should handle changeFile without opening first", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "not-opened.ts");
		writeFileSync(testFile, "const x = 1;");

		await expect(changeFile(testFile, "const x = 2;")).resolves.toBeUndefined();
	});

	it("should handle closeFile on non-opened file", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "not-opened.ts");

		await expect(closeFile(testFile)).resolves.toBeUndefined();
	});

	it("should handle hover with no servers configured", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		const results = await hover(testFile, 0, 6);
		expect(results).toEqual([]);
	});

	it("should handle workspaceSymbol with no clients", async () => {
		configureServers([]);
		const results = await workspaceSymbol("test");
		expect(results).toEqual([]);
	});

	it("should handle documentSymbol with no clients", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		const results = await documentSymbol(testFile);
		expect(results).toEqual([]);
	});

	it("should handle collectDiagnostics with no clients", async () => {
		configureServers([]);
		const results = await collectDiagnostics();
		expect(results).toEqual({});
	});

	it("should handle files with no matching server", async () => {
		const testFile = join(TEST_DIR, "test.xyz");
		writeFileSync(testFile, "random content");

		const config: LspServerConfig = {
			id: "ts-only",
			name: "TypeScript Only",
			command: "fake",
			args: [],
			extensions: [".ts"],
		};

		configureServers([config]);

		await expect(touchFile(testFile)).resolves.toBeUndefined();

		const clients = await getClients();
		expect(clients.length).toBe(0);
	});

	it("should handle custom root resolver", async () => {
		const customRoot = join(TEST_DIR, "custom-root");
		mkdirSync(customRoot, { recursive: true });

		const resolver = async (file: string) => {
			return customRoot;
		};

		configureRootResolver(resolver);
		configureServers([]);

		// Root resolver is configured, touchFile should work
		const testFile = join(TEST_DIR, "test.ts");
		writeFileSync(testFile, "const x = 1;");

		await expect(touchFile(testFile)).resolves.toBeUndefined();
	});

	it("should handle languageId for files without extension", () => {
		expect(languageIdFromFile("/path/to/file")).toBe("plaintext");
		expect(languageIdFromFile("file")).toBe("plaintext");
	});

	it("should handle languageId for uncommon extensions", () => {
		expect(languageIdFromFile("/path/to/file.xyz")).toBe("plaintext");
		expect(languageIdFromFile("/path/to/file.unknown")).toBe("plaintext");
	});

	it("should handle special file names case-insensitively", () => {
		expect(languageIdFromFile("/path/to/Makefile")).toBe("makefile");
		expect(languageIdFromFile("/path/to/makefile")).toBe("makefile");
		expect(languageIdFromFile("/path/to/MAKEFILE")).toBe("makefile");
	});

	it("should export all SymbolKind values correctly", () => {
		expect(SymbolKind.File).toBe(1);
		expect(SymbolKind.Module).toBe(2);
		expect(SymbolKind.Namespace).toBe(3);
		expect(SymbolKind.Package).toBe(4);
		expect(SymbolKind.Class).toBe(5);
		expect(SymbolKind.Method).toBe(6);
		expect(SymbolKind.Property).toBe(7);
		expect(SymbolKind.Field).toBe(8);
		expect(SymbolKind.Constructor).toBe(9);
		expect(SymbolKind.Enum).toBe(10);
		expect(SymbolKind.Interface).toBe(11);
		expect(SymbolKind.Function).toBe(12);
		expect(SymbolKind.Variable).toBe(13);
		expect(SymbolKind.Constant).toBe(14);
		expect(SymbolKind.String).toBe(15);
		expect(SymbolKind.Number).toBe(16);
		expect(SymbolKind.Boolean).toBe(17);
		expect(SymbolKind.Array).toBe(18);
		expect(SymbolKind.Object).toBe(19);
		expect(SymbolKind.Key).toBe(20);
		expect(SymbolKind.Null).toBe(21);
		expect(SymbolKind.EnumMember).toBe(22);
		expect(SymbolKind.Struct).toBe(23);
		expect(SymbolKind.Event).toBe(24);
		expect(SymbolKind.Operator).toBe(25);
		expect(SymbolKind.TypeParameter).toBe(26);
	});

	it("should handle concurrent touchFile calls", async () => {
		configureServers([]);

		const files = [
			join(TEST_DIR, "file1.ts"),
			join(TEST_DIR, "file2.ts"),
			join(TEST_DIR, "file3.ts"),
		];

		for (const file of files) {
			writeFileSync(file, "const x = 1;");
		}

		// Touch all files concurrently
		await expect(
			Promise.all(files.map((f) => touchFile(f))),
		).resolves.toBeDefined();
	});

	it("should handle rapid changeFile calls", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "rapid.ts");
		writeFileSync(testFile, "const x = 1;");

		// Rapid changes
		await changeFile(testFile, "const x = 2;");
		await changeFile(testFile, "const x = 3;");
		await changeFile(testFile, "const x = 4;");

		// Should complete without errors
		expect(true).toBe(true);
	});

	it("should handle empty file content", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "empty.ts");
		writeFileSync(testFile, "");

		await expect(touchFile(testFile)).resolves.toBeUndefined();
		await expect(changeFile(testFile, "")).resolves.toBeUndefined();
	});

	it("should handle very large file content", async () => {
		configureServers([]);
		const testFile = join(TEST_DIR, "large.ts");
		const largeContent = "const x = 1;\n".repeat(10000);
		writeFileSync(testFile, largeContent);

		await expect(touchFile(testFile)).resolves.toBeUndefined();
		await expect(changeFile(testFile, largeContent)).resolves.toBeUndefined();
	});

	it("should handle file paths with special characters", async () => {
		configureServers([]);

		const specialDir = join(TEST_DIR, "special (dir) [test]");
		mkdirSync(specialDir, { recursive: true });

		const testFile = join(specialDir, "file-with-dash.ts");
		writeFileSync(testFile, "const x = 1;");

		await expect(touchFile(testFile)).resolves.toBeUndefined();
	});

	it("should handle relative vs absolute paths", async () => {
		configureServers([]);

		const testFile = join(TEST_DIR, "relative.ts");
		writeFileSync(testFile, "const x = 1;");

		// Both absolute and relative should work
		await expect(touchFile(testFile)).resolves.toBeUndefined();

		const relativePath = "tmp/lsp-edge-cases-tests/relative.ts";
		await expect(touchFile(relativePath)).resolves.toBeUndefined();
	});
});
