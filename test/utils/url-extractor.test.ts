import { describe, expect, it } from "vitest";
import {
	extractAllUrls,
	extractUrlsFromShellCommand,
	extractUrlsFromValue,
} from "../../src/utils/url-extractor.js";

describe("extractUrlsFromValue", () => {
	describe("string values", () => {
		it("extracts single HTTP URL", () => {
			expect(extractUrlsFromValue("Check http://example.com")).toEqual([
				"http://example.com",
			]);
		});

		it("extracts single HTTPS URL", () => {
			expect(extractUrlsFromValue("Visit https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("extracts multiple URLs", () => {
			expect(
				extractUrlsFromValue(
					"See https://one.com and http://two.com for details",
				),
			).toEqual(["https://one.com", "http://two.com"]);
		});

		it("extracts URL with path", () => {
			expect(
				extractUrlsFromValue("API at https://api.example.com/v1/users"),
			).toEqual(["https://api.example.com/v1/users"]);
		});

		it("extracts URL with query parameters", () => {
			expect(
				extractUrlsFromValue("Link: https://example.com/search?q=test&page=1"),
			).toEqual(["https://example.com/search?q=test&page=1"]);
		});

		it("strips trailing punctuation", () => {
			expect(extractUrlsFromValue("See https://example.com.")).toEqual([
				"https://example.com",
			]);
			expect(extractUrlsFromValue("Link: https://example.com,")).toEqual([
				"https://example.com",
			]);
			expect(extractUrlsFromValue("(https://example.com)")).toEqual([
				"https://example.com",
			]);
		});

		it("returns empty array for no URLs", () => {
			expect(extractUrlsFromValue("No URLs here")).toEqual([]);
		});

		it("returns empty array for empty string", () => {
			expect(extractUrlsFromValue("")).toEqual([]);
		});
	});

	describe("object values", () => {
		it("extracts from simple object", () => {
			expect(extractUrlsFromValue({ url: "https://example.com" })).toEqual([
				"https://example.com",
			]);
		});

		it("extracts from nested object", () => {
			expect(
				extractUrlsFromValue({
					config: {
						api: {
							endpoint: "https://api.example.com",
						},
					},
				}),
			).toEqual(["https://api.example.com"]);
		});

		it("extracts from multiple properties", () => {
			const result = extractUrlsFromValue({
				primary: "https://one.com",
				secondary: "https://two.com",
			});
			expect(result).toContain("https://one.com");
			expect(result).toContain("https://two.com");
		});
	});

	describe("array values", () => {
		it("extracts from string array", () => {
			expect(
				extractUrlsFromValue(["https://one.com", "https://two.com"]),
			).toEqual(["https://one.com", "https://two.com"]);
		});

		it("extracts from mixed array", () => {
			expect(
				extractUrlsFromValue([
					"https://one.com",
					{ url: "https://two.com" },
					["https://three.com"],
				]),
			).toEqual(["https://one.com", "https://two.com", "https://three.com"]);
		});
	});

	describe("edge cases", () => {
		it("handles null", () => {
			expect(extractUrlsFromValue(null)).toEqual([]);
		});

		it("handles undefined", () => {
			expect(extractUrlsFromValue(undefined)).toEqual([]);
		});

		it("handles numbers", () => {
			expect(extractUrlsFromValue(42)).toEqual([]);
		});

		it("handles booleans", () => {
			expect(extractUrlsFromValue(true)).toEqual([]);
		});
	});
});

describe("extractUrlsFromShellCommand", () => {
	describe("curl commands", () => {
		it("extracts URL from simple curl", () => {
			expect(extractUrlsFromShellCommand("curl https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("extracts URL from curl with flags (includes flag values)", () => {
			// Note: Flag values like POST are also captured - caller should filter if needed
			const result = extractUrlsFromShellCommand(
				"curl -X POST https://api.example.com",
			);
			expect(result).toContain("https://api.example.com");
		});

		it("adds http:// to bare hostname", () => {
			expect(extractUrlsFromShellCommand("curl example.com/api")).toEqual([
				"http://example.com/api",
			]);
		});

		it("extracts URL from quoted argument", () => {
			expect(
				extractUrlsFromShellCommand('curl "https://example.com/path"'),
			).toEqual(["https://example.com/path"]);
		});
	});

	describe("wget commands", () => {
		it("extracts URL from simple wget", () => {
			expect(extractUrlsFromShellCommand("wget https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("extracts URL from wget with flags (includes flag values)", () => {
			// Note: Flag values are also captured - caller should filter if needed
			const result = extractUrlsFromShellCommand(
				"wget -O output.txt https://example.com",
			);
			expect(result).toContain("https://example.com");
		});

		it("adds http:// to bare hostname", () => {
			expect(extractUrlsFromShellCommand("wget example.com/file.zip")).toEqual([
				"http://example.com/file.zip",
			]);
		});
	});

	describe("edge cases", () => {
		it("returns empty array for non-curl/wget commands", () => {
			expect(extractUrlsFromShellCommand("echo hello")).toEqual([]);
		});

		it("returns empty array for empty string", () => {
			expect(extractUrlsFromShellCommand("")).toEqual([]);
		});

		it("handles command with pipe", () => {
			expect(
				extractUrlsFromShellCommand("curl https://example.com | grep test"),
			).toEqual(["https://example.com"]);
		});

		it("strips trailing punctuation", () => {
			expect(extractUrlsFromShellCommand("curl https://example.com;")).toEqual([
				"https://example.com",
			]);
		});

		it("does not add http:// for whitespace-only or empty argument", () => {
			expect(extractUrlsFromShellCommand('curl "  "')).toEqual([]);
			expect(extractUrlsFromShellCommand("curl ''")).toEqual([]);
		});
	});
});

describe("extractAllUrls", () => {
	it("combines value and shell command extraction", () => {
		const result = extractAllUrls(
			{ url: "https://one.com" },
			"curl https://two.com",
		);
		expect(result).toContain("https://one.com");
		expect(result).toContain("https://two.com");
	});

	it("deduplicates URLs", () => {
		const result = extractAllUrls(
			{ url: "https://example.com" },
			"curl https://example.com",
		);
		expect(result).toEqual(["https://example.com"]);
	});

	it("works without shell command", () => {
		const result = extractAllUrls({ url: "https://example.com" });
		expect(result).toEqual(["https://example.com"]);
	});

	it("works with only shell command", () => {
		const result = extractAllUrls({}, "curl https://example.com");
		expect(result).toEqual(["https://example.com"]);
	});
});
