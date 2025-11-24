/**
 * Comprehensive tests for file system utilities (src/utils/fs.ts)
 *
 * Test Coverage:
 * - File existence checks
 * - Read/write operations with error handling
 * - JSON file operations
 * - Directory creation
 * - Atomic writes
 * - Permission checks
 * - Edge cases and error conditions
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FileSystemError,
	appendTextFile,
	ensureDir,
	fileExists,
	isReadable,
	isWritable,
	readJsonFile,
	readTextFile,
	writeJsonFile,
	writeTextFile,
	writeTextFileAtomic,
} from "../../src/utils/fs.js";

describe("fs utilities", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a temporary directory for each test
		testDir = mkdtempSync(join(tmpdir(), "composer-fs-test-"));
	});

	afterEach(() => {
		// Clean up after each test
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch (error) {
			console.warn("Failed to clean up test directory:", error);
		}
	});

	describe("fileExists", () => {
		it("should return true for existing files", () => {
			const filePath = join(testDir, "exists.txt");
			writeFileSync(filePath, "content");
			expect(fileExists(filePath)).toBe(true);
		});

		it("should return false for non-existent files", () => {
			const filePath = join(testDir, "does-not-exist.txt");
			expect(fileExists(filePath)).toBe(false);
		});

		it("should return true for existing directories", () => {
			expect(fileExists(testDir)).toBe(true);
		});

		it("should handle invalid paths gracefully", () => {
			expect(fileExists("\0invalid")).toBe(false);
		});
	});

	describe("readTextFile", () => {
		it("should read file content successfully", () => {
			const filePath = join(testDir, "read.txt");
			const content = "Hello, World!";
			writeFileSync(filePath, content);

			const result = readTextFile(filePath);
			expect(result).toBe(content);
		});

		it("should handle UTF-8 content correctly", () => {
			const filePath = join(testDir, "unicode.txt");
			const content = "🚀 Emoji and 中文 characters";
			writeFileSync(filePath, content, "utf-8");

			const result = readTextFile(filePath);
			expect(result).toBe(content);
		});

		it("should throw FileSystemError for non-existent file", () => {
			const filePath = join(testDir, "missing.txt");

			expect(() => readTextFile(filePath)).toThrow(FileSystemError);
			expect(() => readTextFile(filePath)).toThrow(/File not found/);
		});

		it("should return fallback for non-existent file when provided", () => {
			const filePath = join(testDir, "missing.txt");
			const fallback = "default content";

			const result = readTextFile(filePath, { fallback });
			expect(result).toBe(fallback);
		});

		it("should support different encodings", () => {
			const filePath = join(testDir, "encoded.txt");
			const content = "Test content";
			writeFileSync(filePath, content, "utf-8");

			const result = readTextFile(filePath, { encoding: "utf-8" });
			expect(result).toBe(content);
		});

		it("should handle empty files", () => {
			const filePath = join(testDir, "empty.txt");
			writeFileSync(filePath, "");

			const result = readTextFile(filePath);
			expect(result).toBe("");
		});

		it("should handle large files", () => {
			const filePath = join(testDir, "large.txt");
			const content = "x".repeat(10000);
			writeFileSync(filePath, content);

			const result = readTextFile(filePath);
			expect(result).toBe(content);
			expect(result.length).toBe(10000);
		});
	});

	describe("writeTextFile", () => {
		it("should write file content successfully", () => {
			const filePath = join(testDir, "write.txt");
			const content = "Test content";

			writeTextFile(filePath, content);
			expect(fileExists(filePath)).toBe(true);

			const readBack = readTextFile(filePath);
			expect(readBack).toBe(content);
		});

		it("should create parent directories by default", () => {
			const filePath = join(testDir, "nested", "dir", "file.txt");
			const content = "Nested content";

			writeTextFile(filePath, content);
			expect(fileExists(filePath)).toBe(true);

			const readBack = readTextFile(filePath);
			expect(readBack).toBe(content);
		});

		it("should not create directories when createDirs is false", () => {
			const filePath = join(testDir, "nested2", "file.txt");
			const content = "Content";

			expect(() =>
				writeTextFile(filePath, content, { createDirs: false }),
			).toThrow(FileSystemError);
		});

		it("should overwrite existing files", () => {
			const filePath = join(testDir, "overwrite.txt");
			writeFileSync(filePath, "old content");

			const newContent = "new content";
			writeTextFile(filePath, newContent);

			const readBack = readTextFile(filePath);
			expect(readBack).toBe(newContent);
		});

		it("should handle empty content", () => {
			const filePath = join(testDir, "empty-write.txt");
			writeTextFile(filePath, "");

			expect(fileExists(filePath)).toBe(true);
			expect(readTextFile(filePath)).toBe("");
		});

		it("should handle special characters", () => {
			const filePath = join(testDir, "special.txt");
			const content = "Line 1\nLine 2\tTabbed\r\nWindows line";

			writeTextFile(filePath, content);
			expect(readTextFile(filePath)).toBe(content);
		});
	});

	describe("readJsonFile", () => {
		it("should parse valid JSON correctly", () => {
			const filePath = join(testDir, "data.json");
			const data = { name: "test", value: 42, nested: { key: "val" } };
			writeFileSync(filePath, JSON.stringify(data));

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should handle arrays", () => {
			const filePath = join(testDir, "array.json");
			const data = [1, 2, 3, { id: 4 }];
			writeFileSync(filePath, JSON.stringify(data));

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should throw error for invalid JSON without fallback", () => {
			const filePath = join(testDir, "invalid.json");
			writeFileSync(filePath, "{ invalid json }");

			expect(() => readJsonFile(filePath)).toThrow();
		});

		it("should return fallback for invalid JSON when provided", () => {
			const filePath = join(testDir, "invalid2.json");
			writeFileSync(filePath, "{ broken");
			const fallback = { default: true };

			const result = readJsonFile(filePath, { fallback });
			expect(result).toEqual(fallback);
		});

		it("should return fallback for non-existent file", () => {
			const filePath = join(testDir, "missing.json");
			const fallback = { default: "value" };

			const result = readJsonFile(filePath, { fallback });
			expect(result).toEqual(fallback);
		});

		it("should handle empty JSON object", () => {
			const filePath = join(testDir, "empty-obj.json");
			writeFileSync(filePath, "{}");

			const result = readJsonFile(filePath);
			expect(result).toEqual({});
		});

		it("should handle JSON with special characters", () => {
			const filePath = join(testDir, "special.json");
			const data = { emoji: "🚀", unicode: "中文" };
			writeFileSync(filePath, JSON.stringify(data));

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should preserve number types", () => {
			const filePath = join(testDir, "numbers.json");
			const data = { int: 42, float: 3.14, negative: -100 };
			writeFileSync(filePath, JSON.stringify(data));

			const result = readJsonFile<typeof data>(filePath);
			expect(result.int).toBe(42);
			expect(result.float).toBe(3.14);
			expect(result.negative).toBe(-100);
		});

		it("should handle null and boolean values", () => {
			const filePath = join(testDir, "primitives.json");
			const data = { isTrue: true, isFalse: false, empty: null };
			writeFileSync(filePath, JSON.stringify(data));

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});
	});

	describe("writeJsonFile", () => {
		it("should write JSON with pretty formatting by default", () => {
			const filePath = join(testDir, "output.json");
			const data = { name: "test", value: 42 };

			writeJsonFile(filePath, data);

			const content = readTextFile(filePath);
			expect(content).toContain("\n");
			expect(content).toContain("  "); // indentation
			expect(JSON.parse(content)).toEqual(data);
		});

		it("should write compact JSON when pretty is false", () => {
			const filePath = join(testDir, "compact.json");
			const data = { name: "test", value: 42 };

			writeJsonFile(filePath, data, { pretty: false });

			const content = readTextFile(filePath);
			expect(content).not.toContain("\n  ");
			expect(JSON.parse(content)).toEqual(data);
		});

		it("should create parent directories", () => {
			const filePath = join(testDir, "nested", "data.json");
			const data = { nested: true };

			writeJsonFile(filePath, data);

			expect(fileExists(filePath)).toBe(true);
			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should handle complex nested objects", () => {
			const filePath = join(testDir, "complex.json");
			const data = {
				users: [
					{ id: 1, name: "Alice", meta: { role: "admin" } },
					{ id: 2, name: "Bob", meta: { role: "user" } },
				],
				settings: { theme: "dark", notifications: true },
			};

			writeJsonFile(filePath, data);

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should handle special values", () => {
			const filePath = join(testDir, "special-values.json");
			const data = {
				null: null,
				boolean: true,
				number: 42,
				string: "text",
				array: [1, 2, 3],
			};

			writeJsonFile(filePath, data);

			const result = readJsonFile(filePath);
			expect(result).toEqual(data);
		});

		it("should overwrite existing JSON files", () => {
			const filePath = join(testDir, "overwrite.json");
			writeJsonFile(filePath, { old: true });
			writeJsonFile(filePath, { new: true });

			const result = readJsonFile(filePath);
			expect(result).toEqual({ new: true });
		});
	});

	describe("ensureDir", () => {
		it("should create directory if it doesn't exist", () => {
			const dirPath = join(testDir, "new-dir");
			expect(fileExists(dirPath)).toBe(false);

			ensureDir(dirPath);
			expect(fileExists(dirPath)).toBe(true);
		});

		it("should not throw if directory already exists", () => {
			expect(() => ensureDir(testDir)).not.toThrow();
		});

		it("should create nested directories", () => {
			const dirPath = join(testDir, "a", "b", "c");
			ensureDir(dirPath);
			expect(fileExists(dirPath)).toBe(true);
		});

		it("should handle multiple levels of nesting", () => {
			const dirPath = join(testDir, "level1", "level2", "level3", "level4");
			ensureDir(dirPath);
			expect(fileExists(dirPath)).toBe(true);
		});
	});

	describe("appendTextFile", () => {
		it("should append to existing file", () => {
			const filePath = join(testDir, "append.txt");
			writeFileSync(filePath, "Line 1\n");

			appendTextFile(filePath, "Line 2\n");

			const content = readTextFile(filePath);
			expect(content).toBe("Line 1\nLine 2\n");
		});

		it("should create file if it doesn't exist", () => {
			const filePath = join(testDir, "new-append.txt");
			appendTextFile(filePath, "First line\n");

			expect(fileExists(filePath)).toBe(true);
			expect(readTextFile(filePath)).toBe("First line\n");
		});

		it("should append multiple times", () => {
			const filePath = join(testDir, "multi-append.txt");
			appendTextFile(filePath, "1\n");
			appendTextFile(filePath, "2\n");
			appendTextFile(filePath, "3\n");

			expect(readTextFile(filePath)).toBe("1\n2\n3\n");
		});

		it("should create parent directories when needed", () => {
			const filePath = join(testDir, "nested-append", "file.txt");
			appendTextFile(filePath, "content\n");

			expect(fileExists(filePath)).toBe(true);
		});

		it("should handle empty appends", () => {
			const filePath = join(testDir, "empty-append.txt");
			writeFileSync(filePath, "content");

			appendTextFile(filePath, "");
			expect(readTextFile(filePath)).toBe("content");
		});
	});

	describe("writeTextFileAtomic", () => {
		it("should write file atomically", () => {
			const filePath = join(testDir, "atomic.txt");
			const content = "Atomic content";

			writeTextFileAtomic(filePath, content);

			expect(fileExists(filePath)).toBe(true);
			expect(readTextFile(filePath)).toBe(content);
		});

		it("should not leave temp files on success", () => {
			const filePath = join(testDir, "atomic2.txt");
			writeTextFileAtomic(filePath, "content");

			const files = require("node:fs").readdirSync(testDir);
			const tempFiles = files.filter((f: string) => f.includes(".tmp."));
			expect(tempFiles).toHaveLength(0);
		});

		it("should overwrite existing file atomically", () => {
			const filePath = join(testDir, "atomic-overwrite.txt");
			writeFileSync(filePath, "old content");

			const newContent = "new atomic content";
			writeTextFileAtomic(filePath, newContent);

			expect(readTextFile(filePath)).toBe(newContent);
		});

		it("should handle special characters", () => {
			const filePath = join(testDir, "atomic-special.txt");
			const content = "Special: 🚀\n中文\nтекст";

			writeTextFileAtomic(filePath, content);
			expect(readTextFile(filePath)).toBe(content);
		});
	});

	describe("isReadable", () => {
		it("should return true for readable files", async () => {
			const filePath = join(testDir, "readable.txt");
			writeFileSync(filePath, "content");

			const result = await isReadable(filePath);
			expect(result).toBe(true);
		});

		it("should return false for non-existent files", async () => {
			const filePath = join(testDir, "missing.txt");
			const result = await isReadable(filePath);
			expect(result).toBe(false);
		});

		// Skip on Windows or if running as root
		const shouldTestPermissions =
			process.platform !== "win32" && process.getuid?.() !== 0;

		it.skipIf(!shouldTestPermissions)(
			"should return false for non-readable files",
			async () => {
				const filePath = join(testDir, "unreadable.txt");
				writeFileSync(filePath, "content");
				chmodSync(filePath, 0o000); // Remove all permissions

				const result = await isReadable(filePath);
				expect(result).toBe(false);

				// Restore permissions for cleanup
				chmodSync(filePath, 0o644);
			},
		);
	});

	describe("isWritable", () => {
		it("should return true for writable files", async () => {
			const filePath = join(testDir, "writable.txt");
			writeFileSync(filePath, "content");

			const result = await isWritable(filePath);
			expect(result).toBe(true);
		});

		it("should return false for non-existent files", async () => {
			const filePath = join(testDir, "missing.txt");
			const result = await isWritable(filePath);
			expect(result).toBe(false);
		});

		const shouldTestPermissions =
			process.platform !== "win32" && process.getuid?.() !== 0;

		it.skipIf(!shouldTestPermissions)(
			"should return false for read-only files",
			async () => {
				const filePath = join(testDir, "readonly.txt");
				writeFileSync(filePath, "content");
				chmodSync(filePath, 0o444); // Read-only

				const result = await isWritable(filePath);
				expect(result).toBe(false);

				// Restore permissions for cleanup
				chmodSync(filePath, 0o644);
			},
		);
	});

	describe("FileSystemError", () => {
		it("should include path and operation in error", () => {
			const error = new FileSystemError("Test error", "/test/path.txt", "read");

			expect(error.message).toBe("Test error");
			expect(error.path).toBe("/test/path.txt");
			expect(error.operation).toBe("read");
			expect(error.name).toBe("FileSystemError");
		});

		it("should include cause when provided", () => {
			const cause = new Error("Original error");
			const error = new FileSystemError(
				"Wrapper error",
				"/path.txt",
				"write",
				cause,
			);

			expect(error.cause).toBe(cause);
		});
	});

	describe("edge cases", () => {
		it("should handle very long file paths", () => {
			const longName = "a".repeat(100);
			const filePath = join(testDir, `${longName}.txt`);

			writeTextFile(filePath, "content");
			expect(readTextFile(filePath)).toBe("content");
		});

		it("should handle file names with spaces", () => {
			const filePath = join(testDir, "file with spaces.txt");
			writeTextFile(filePath, "content");
			expect(readTextFile(filePath)).toBe("content");
		});

		it("should handle file names with special characters", () => {
			const filePath = join(testDir, "file-name_with.special@chars.txt");
			writeTextFile(filePath, "content");
			expect(readTextFile(filePath)).toBe("content");
		});

		it("should handle concurrent writes to different files", async () => {
			const promises = Array.from({ length: 10 }, (_, i) => {
				const filePath = join(testDir, `concurrent-${i}.txt`);
				return Promise.resolve(writeTextFile(filePath, `content ${i}`));
			});

			await Promise.all(promises);

			for (let i = 0; i < 10; i++) {
				const filePath = join(testDir, `concurrent-${i}.txt`);
				expect(readTextFile(filePath)).toBe(`content ${i}`);
			}
		});

		it("should handle binary-looking content in text files", () => {
			const filePath = join(testDir, "binary-like.txt");
			const content = "\x00\x01\x02\xFF";
			writeTextFile(filePath, content);
			expect(readTextFile(filePath)).toBe(content);
		});
	});
});
