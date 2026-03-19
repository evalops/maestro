import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SubstitutionLogger,
	substituteEnvVars,
	substituteFileRefs,
} from "../../src/utils/config-substitution.js";

describe("substituteEnvVars", () => {
	const TEST_VAR = "TEST_CONFIG_VAR";
	const TEST_VAR2 = "TEST_CONFIG_VAR2";

	beforeEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
		Reflect.deleteProperty(process.env, TEST_VAR2);
	});

	afterEach(() => {
		Reflect.deleteProperty(process.env, TEST_VAR);
		Reflect.deleteProperty(process.env, TEST_VAR2);
	});

	it("substitutes single environment variable", () => {
		process.env[TEST_VAR] = "secret123";
		const result = substituteEnvVars('{"apiKey": "{env:TEST_CONFIG_VAR}"}');
		expect(result).toBe('{"apiKey": "secret123"}');
	});

	it("substitutes multiple environment variables", () => {
		process.env[TEST_VAR] = "value1";
		process.env[TEST_VAR2] = "value2";
		const result = substituteEnvVars(
			'{"a": "{env:TEST_CONFIG_VAR}", "b": "{env:TEST_CONFIG_VAR2}"}',
		);
		expect(result).toBe('{"a": "value1", "b": "value2"}');
	});

	it("substitutes same variable multiple times", () => {
		process.env[TEST_VAR] = "repeated";
		const result = substituteEnvVars(
			"{env:TEST_CONFIG_VAR} and {env:TEST_CONFIG_VAR}",
		);
		expect(result).toBe("repeated and repeated");
	});

	it("returns empty string for unset variables", () => {
		const result = substituteEnvVars('{"key": "{env:UNSET_VAR_12345}"}');
		expect(result).toBe('{"key": ""}');
	});

	it("logs warning for unset variables when logger provided", () => {
		const mockLogger: SubstitutionLogger = {
			warn: vi.fn(),
		};
		substituteEnvVars('{"key": "{env:UNSET_VAR_12345}"}', mockLogger);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			"Environment variable not set, using empty string",
			{ varName: "UNSET_VAR_12345" },
		);
	});

	it("does not log when no logger provided", () => {
		// Should not throw
		const result = substituteEnvVars('{"key": "{env:UNSET_VAR_12345}"}');
		expect(result).toBe('{"key": ""}');
	});

	it("preserves text without env vars", () => {
		const text = '{"key": "value", "number": 123}';
		expect(substituteEnvVars(text)).toBe(text);
	});

	it("handles empty string", () => {
		expect(substituteEnvVars("")).toBe("");
	});

	it("handles variable with special characters in value", () => {
		process.env[TEST_VAR] = 'value with "quotes" and \\ backslash';
		const result = substituteEnvVars("{env:TEST_CONFIG_VAR}");
		expect(result).toBe('value with "quotes" and \\ backslash');
	});

	it("handles variable names with underscores and numbers", () => {
		process.env.MY_VAR_123 = "test";
		const result = substituteEnvVars("{env:MY_VAR_123}");
		expect(result).toBe("test");
		process.env.MY_VAR_123 = undefined;
	});

	it("trims whitespace around env var name in placeholder", () => {
		process.env.TRIM_ME = "ok";
		const result = substituteEnvVars('{"x": "{env:  TRIM_ME  }"}');
		expect(result).toBe('{"x": "ok"}');
		Reflect.deleteProperty(process.env, "TRIM_ME");
	});
});

describe("substituteFileRefs", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `config-sub-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("substitutes file reference with relative path", () => {
		writeFileSync(join(testDir, "secret.txt"), "my-secret-value");
		const result = substituteFileRefs(
			'{"apiKey": "{file:secret.txt}"}',
			testDir,
		);
		expect(result).toBe('{"apiKey": "my-secret-value"}\n');
	});

	it("substitutes file reference with absolute path", () => {
		const filePath = join(testDir, "absolute.txt");
		writeFileSync(filePath, "absolute-value");
		const result = substituteFileRefs(
			`{"key": "{file:${filePath}}"}`,
			"/other/dir",
		);
		expect(result).toBe('{"key": "absolute-value"}\n');
	});

	it("substitutes multiple file references", () => {
		writeFileSync(join(testDir, "file1.txt"), "value1");
		writeFileSync(join(testDir, "file2.txt"), "value2");
		const result = substituteFileRefs(
			'{"a": "{file:file1.txt}", "b": "{file:file2.txt}"}',
			testDir,
		);
		expect(result).toBe('{"a": "value1", "b": "value2"}\n');
	});

	it("escapes file content for JSON (newlines)", () => {
		writeFileSync(join(testDir, "multiline.txt"), "line1\nline2\nline3");
		const result = substituteFileRefs(
			'{"content": "{file:multiline.txt}"}',
			testDir,
		);
		expect(result).toBe('{"content": "line1\\nline2\\nline3"}\n');
	});

	it("escapes file content for JSON (quotes)", () => {
		writeFileSync(join(testDir, "quotes.txt"), 'value with "quotes"');
		const result = substituteFileRefs(
			'{"content": "{file:quotes.txt}"}',
			testDir,
		);
		expect(result).toBe('{"content": "value with \\"quotes\\""}\n');
	});

	it("escapes file content for JSON (backslashes)", () => {
		writeFileSync(join(testDir, "backslash.txt"), "path\\to\\file");
		const result = substituteFileRefs(
			'{"content": "{file:backslash.txt}"}',
			testDir,
		);
		expect(result).toBe('{"content": "path\\\\to\\\\file"}\n');
	});

	it("trims whitespace from file content", () => {
		writeFileSync(join(testDir, "whitespace.txt"), "  trimmed  \n\n");
		const result = substituteFileRefs(
			'{"key": "{file:whitespace.txt}"}',
			testDir,
		);
		expect(result).toBe('{"key": "trimmed"}\n');
	});

	it("skips file refs in // comments", () => {
		writeFileSync(join(testDir, "secret.txt"), "should-not-appear");
		const input = `// This is a comment {file:secret.txt}
{"key": "value"}`;
		const result = substituteFileRefs(input, testDir);
		expect(result).toContain("// This is a comment {file:secret.txt}");
		expect(result).not.toContain("should-not-appear");
	});

	it("skips file refs in /* comments", () => {
		writeFileSync(join(testDir, "secret.txt"), "should-not-appear");
		const input = `/* Comment {file:secret.txt} */
{"key": "value"}`;
		const result = substituteFileRefs(input, testDir);
		expect(result).toContain("/* Comment {file:secret.txt}");
	});

	it("skips file refs in * comment lines", () => {
		writeFileSync(join(testDir, "secret.txt"), "should-not-appear");
		const input = ` * Comment line {file:secret.txt}
{"key": "value"}`;
		const result = substituteFileRefs(input, testDir);
		expect(result).toContain("* Comment line {file:secret.txt}");
	});

	it("throws error for non-existent file", () => {
		expect(() =>
			substituteFileRefs('{"key": "{file:nonexistent.txt}"}', testDir),
		).toThrow(/Failed to read file reference/);
	});

	it("includes file path in error message", () => {
		expect(() =>
			substituteFileRefs('{"key": "{file:missing.txt}"}', testDir),
		).toThrow(/missing\.txt/);
	});

	it("preserves text without file refs", () => {
		const text = '{"key": "value"}';
		const result = substituteFileRefs(text, testDir);
		expect(result).toBe('{"key": "value"}\n');
	});

	it("handles empty string", () => {
		// Empty string splits to [""], which becomes "\n" after processing
		expect(substituteFileRefs("", testDir)).toBe("\n");
	});

	it("handles nested directory paths", () => {
		const nestedDir = join(testDir, "nested", "dir");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "file.txt"), "nested-value");
		const result = substituteFileRefs(
			'{"key": "{file:nested/dir/file.txt}"}',
			testDir,
		);
		expect(result).toBe('{"key": "nested-value"}\n');
	});

	it("handles multiple refs on same line", () => {
		writeFileSync(join(testDir, "a.txt"), "A");
		writeFileSync(join(testDir, "b.txt"), "B");
		const result = substituteFileRefs(
			'{"a": "{file:a.txt}", "b": "{file:b.txt}"}',
			testDir,
		);
		expect(result).toBe('{"a": "A", "b": "B"}\n');
	});
});
