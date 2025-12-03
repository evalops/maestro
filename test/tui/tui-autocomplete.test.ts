import { describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider } from "../../packages/tui/src/autocomplete.js";

describe("CombinedAutocompleteProvider - Path Extraction", () => {
	describe("extractPathPrefix", () => {
		const provider = new CombinedAutocompleteProvider([], "/test");
		// Access private method for testing via type assertion
		const extractPathPrefix = (
			provider as unknown as {
				extractPathPrefix: (text: string, inQuote: boolean) => string;
			}
		).extractPathPrefix.bind(provider);

		describe("ReDoS prevention", () => {
			it("should handle URLs with many slashes without hanging", () => {
				const url = "https://github.com/evalops/composer/pull/79/files";
				const start = Date.now();
				const result = extractPathPrefix(url, false);
				const elapsed = Date.now() - start;

				// Should complete in milliseconds, not seconds
				expect(elapsed).toBeLessThan(100);
				expect(result).toBe(url);
			});

			it("should handle very long paths with many slashes", () => {
				const longPath = `${"/a/".repeat(1000)}file.txt`;
				const start = Date.now();
				const result = extractPathPrefix(longPath, false);
				const elapsed = Date.now() - start;

				expect(elapsed).toBeLessThan(100);
				expect(result).toBe(longPath);
			});

			it("should handle nested directory patterns", () => {
				const nested = "/foo/bar/../baz/./qux";
				const result = extractPathPrefix(nested, false);
				expect(result).toBe(nested);
			});
		});

		describe("delimiter handling", () => {
			it("should extract path after space delimiter", () => {
				const result = extractPathPrefix("command /path/to/file", false);
				expect(result).toBe("/path/to/file");
			});

			it("should extract path after tab delimiter", () => {
				const result = extractPathPrefix("command\t/path/to/file", false);
				expect(result).toBe("/path/to/file");
			});

			it("should extract path after quote delimiter", () => {
				const result = extractPathPrefix('file="/path/to/file', false);
				expect(result).toBe("/path/to/file");
			});

			it("should extract path after equals delimiter", () => {
				const result = extractPathPrefix("path=/home/user/file", false);
				expect(result).toBe("/home/user/file");
			});

			it("should return empty string after space with forceExtract", () => {
				const result = extractPathPrefix("command ", true);
				expect(result).toBe("");
			});

			it("should return empty string after tab with forceExtract", () => {
				const result = extractPathPrefix("command\t", true);
				expect(result).toBe("");
			});
		});

		describe("@path syntax", () => {
			it("should extract @path pattern", () => {
				const result = extractPathPrefix("attach @src/main", false);
				expect(result).toBe("@src/main");
			});

			it("should extract partial @path", () => {
				const result = extractPathPrefix("attach @sr", false);
				expect(result).toBe("@sr");
			});
		});

		describe("natural trigger patterns", () => {
			it("should trigger on ./ prefix", () => {
				const result = extractPathPrefix("./src", false);
				expect(result).toBe("./src");
			});

			it("should trigger on ../ prefix", () => {
				const result = extractPathPrefix("../test", false);
				expect(result).toBe("../test");
			});

			it("should trigger on ~/ prefix", () => {
				const result = extractPathPrefix("~/Documents", false);
				expect(result).toBe("~/Documents");
			});

			it("should trigger on paths with slashes", () => {
				const result = extractPathPrefix("src/main.ts", false);
				expect(result).toBe("src/main.ts");
			});

			it("should not trigger on random words", () => {
				const result = extractPathPrefix("hello world", false);
				expect(result).toBeNull();
			});

			it("should return empty string at start of line", () => {
				const result = extractPathPrefix("", false);
				expect(result).toBe("");
			});
		});

		describe("edge cases", () => {
			it("should handle single character paths", () => {
				const result = extractPathPrefix("/", false);
				expect(result).toBe("/");
			});

			it("should handle tilde alone with force extract", () => {
				const result = extractPathPrefix("~", true);
				expect(result).toBe("~");
			});

			it("should handle multiple spaces", () => {
				const result = extractPathPrefix("  /path", false);
				expect(result).toBe("/path");
			});

			it("should handle trailing slash", () => {
				const result = extractPathPrefix("/path/to/dir/", false);
				expect(result).toBe("/path/to/dir/");
			});

			it("should extract last word when multiple paths present", () => {
				const result = extractPathPrefix("/first/path /second/path", false);
				expect(result).toBe("/second/path");
			});
		});
	});
});
