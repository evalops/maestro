import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LspServerConfig } from "../../src/lsp/index.js";

vi.mock("node:fs", () => {
	return {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => JSON.stringify({})),
		writeFileSync: vi.fn(),
	};
});

describe("lsp config", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("returns defaults when disabled", async () => {
		const defaults: LspServerConfig[] = [
			{ id: "ts", command: "tsserver", extensions: [".ts"] },
		];
		const { applyServerOverrides } = await import(
			"../../src/config/lsp-config.js"
		);
		const result = applyServerOverrides(defaults);
		expect(result).toEqual(defaults);
	});
});
