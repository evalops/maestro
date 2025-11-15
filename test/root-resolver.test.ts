import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	resetWorkspaceRootCacheForTests,
	resolveWorkspaceRoot,
} from "../src/workspace/root-resolver.js";

describe("resolveWorkspaceRoot", () => {
	let tempDir: string;

	beforeEach(() => {
		resetWorkspaceRootCacheForTests();
		tempDir = mkdtempSync(join(tmpdir(), "workspace-test-"));
	});

	it("detects root via marker", async () => {
		const root = join(tempDir, "project");
		const file = join(root, "src", "index.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(file, "");
		writeFileSync(join(root, "package.json"), "{}");
		const resolved = await resolveWorkspaceRoot(file);
		expect(resolved).toBe(root);
	});

	it("returns undefined when no marker found", async () => {
		const file = join(tempDir, "file.ts");
		writeFileSync(file, "");
		const resolved = await resolveWorkspaceRoot(file);
		expect(resolved).toBeUndefined();
	});
});
