import { describe, expect, it } from "vitest";
import {
	LANGUAGE_EXTENSIONS,
	languageIdFromFile,
} from "../src/lsp/language.js";

describe("Language mapping", () => {
	it("should map TypeScript extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.ts")).toBe("typescript");
		expect(languageIdFromFile("/path/to/file.tsx")).toBe("typescriptreact");
		expect(languageIdFromFile("/path/to/file.mts")).toBe("typescript");
		expect(languageIdFromFile("/path/to/file.cts")).toBe("typescript");
	});

	it("should map JavaScript extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.js")).toBe("javascript");
		expect(languageIdFromFile("/path/to/file.jsx")).toBe("javascriptreact");
		expect(languageIdFromFile("/path/to/file.mjs")).toBe("javascript");
		expect(languageIdFromFile("/path/to/file.cjs")).toBe("javascript");
	});

	it("should map Python extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.py")).toBe("python");
	});

	it("should map Go extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.go")).toBe("go");
	});

	it("should map Rust extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.rs")).toBe("rust");
	});

	it("should map Vue extensions correctly", () => {
		expect(languageIdFromFile("/path/to/file.vue")).toBe("vue");
	});

	it("should map special file names correctly", () => {
		expect(languageIdFromFile("/path/to/makefile")).toBe("makefile");
		expect(languageIdFromFile("/path/to/Makefile")).toBe("makefile");
	});

	it("should return plaintext for unknown extensions", () => {
		expect(languageIdFromFile("/path/to/file.unknown")).toBe("plaintext");
		expect(languageIdFromFile("/path/to/file")).toBe("plaintext");
	});

	it("should have a comprehensive language mapping", () => {
		const extensions = Object.keys(LANGUAGE_EXTENSIONS);
		expect(extensions.length).toBeGreaterThan(90);
		expect(extensions).toContain(".ts");
		expect(extensions).toContain(".py");
		expect(extensions).toContain(".go");
		expect(extensions).toContain(".rs");
		expect(extensions).toContain(".vue");
		expect(extensions).toContain(".java");
		expect(extensions).toContain(".rb");
		expect(extensions).toContain(".php");
	});
});
