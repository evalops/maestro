import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadComposers } from "../../src/composers/loader.js";

describe("Composers loader", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `composers-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns empty array when no composers exist (excluding builtin)", () => {
		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toEqual([]);
	});

	it("loads composer from JSON file", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "test.json"),
			JSON.stringify({
				name: "test-composer",
				description: "A test composer",
				systemPrompt: "You are a helpful assistant.",
				tools: ["read", "search"],
				model: "claude-sonnet-4-20250514",
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("test-composer");
		expect(composers[0]!.description).toBe("A test composer");
		expect(composers[0]!.tools).toEqual(["read", "search"]);
		expect(composers[0]!.source).toBe("project");
	});

	it("loads composer from YAML file", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "yaml-test.yaml"),
			`name: yaml-composer
description: A YAML composer
tools: [read, write, bash]
`,
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("yaml-composer");
		expect(composers[0]!.tools).toEqual(["read", "write", "bash"]);
	});

	it("uses filename as name when name not specified", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "unnamed.json"),
			JSON.stringify({
				description: "Has no name field",
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("unnamed");
	});

	it("excludes disabled composers", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "enabled.json"),
			JSON.stringify({ name: "enabled", description: "Enabled" }),
		);
		writeFileSync(
			join(composersDir, "disabled.json"),
			JSON.stringify({
				name: "disabled",
				description: "Disabled",
				enabled: false,
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("enabled");
	});

	it("normalizes tools string to array", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "string-tools.json"),
			JSON.stringify({
				name: "string-tools",
				tools: "read search write",
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.tools).toEqual(["read", "search", "write"]);
	});

	it("normalizes comma-separated tools string to array", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "comma-tools.json"),
			JSON.stringify({
				name: "comma-tools",
				tools: "read, search, write",
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.tools).toEqual(["read", "search", "write"]);
	});

	it("keeps tools as array when already an array", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "array-tools.json"),
			JSON.stringify({
				name: "array-tools",
				tools: ["read", "write"],
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.tools).toEqual(["read", "write"]);
	});

	it("sets tools to undefined for invalid tools type", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "invalid-tools.json"),
			JSON.stringify({
				name: "invalid-tools",
				tools: 123,
			}),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.tools).toBeUndefined();
	});

	it("rejects path traversal via symlinks", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });

		// Create a directory outside the composers dir
		const outsideDir = join(testDir, "outside");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(
			join(outsideDir, "secret.json"),
			JSON.stringify({
				name: "secret",
				description: "Should not be loaded",
			}),
		);

		// Create a symlink pointing outside
		try {
			symlinkSync(
				join(outsideDir, "secret.json"),
				join(composersDir, "malicious.json"),
			);
		} catch {
			// Skip test if symlinks not supported
			return;
		}

		const composers = loadComposers(testDir, { includeBuiltin: false });
		// The symlinked file should be rejected
		expect(composers.find((c) => c.name === "secret")).toBeUndefined();
	});

	it("handles YAML multiline strings correctly", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "multiline.yaml"),
			`name: multiline-composer
description: Has multiline content
systemPrompt: |
  You are a helpful assistant.
  
  Please follow these rules:
  - Be concise
  - Be accurate
`,
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("multiline-composer");
		expect(composers[0]!.systemPrompt).toContain(
			"You are a helpful assistant.",
		);
		expect(composers[0]!.systemPrompt).toContain("Be concise");
	});

	it("handles YAML nested objects (triggers)", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "triggers.yaml"),
			`name: triggered-composer
description: Has triggers
triggers:
  keywords:
    - deploy
    - release
  files:
    - "*.tf"
    - "*.hcl"
`,
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.triggers).toBeDefined();
		expect(composers[0]!.triggers?.keywords).toEqual(["deploy", "release"]);
		expect(composers[0]!.triggers?.files).toEqual(["*.tf", "*.hcl"]);
	});

	it("ignores non-config files", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "valid.json"),
			JSON.stringify({ name: "valid" }),
		);
		writeFileSync(join(composersDir, "readme.md"), "# Readme");
		writeFileSync(join(composersDir, "notes.txt"), "Some notes");

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("valid");
	});

	it("handles malformed JSON gracefully", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(join(composersDir, "malformed.json"), "{ invalid json }");
		writeFileSync(
			join(composersDir, "valid.json"),
			JSON.stringify({ name: "valid" }),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("valid");
	});

	it("handles malformed YAML gracefully", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "malformed.yaml"),
			`name: test
  invalid: indentation
`,
		);
		writeFileSync(
			join(composersDir, "valid.json"),
			JSON.stringify({ name: "valid" }),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("valid");
	});

	it("loads .yml extension same as .yaml", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "test.yml"),
			`name: yml-composer
description: Uses .yml extension
`,
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.name).toBe("yml-composer");
	});

	it("adds default description when not specified", () => {
		const composersDir = join(testDir, ".maestro", "composers");
		mkdirSync(composersDir, { recursive: true });
		writeFileSync(
			join(composersDir, "no-desc.json"),
			JSON.stringify({ name: "no-desc" }),
		);

		const composers = loadComposers(testDir, { includeBuiltin: false });
		expect(composers).toHaveLength(1);
		expect(composers[0]!.description).toBe("Custom composer: no-desc");
	});
});
