import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLspServers } from "../src/lsp/autodetect.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "composer-lsp-test-"));
}

describe("detectLspServers", () => {
	it("finds typescript when lockfile and binary present", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "package-lock.json"), "{}");
		const fakeBinDir = tempDir();
		const fakeTs = join(fakeBinDir, "typescript-language-server");
		writeFileSync(fakeTs, "#!/bin/sh\nexit 0\n");
		chmodSync(fakeTs, 0o755);
		process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;
		const detections = await detectLspServers(dir);
		const ts = detections.find((d) => d.serverId === "typescript");
		expect(ts?.root).toBe(dir);
	});

	it("skips when binary missing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "package-lock.json"), "{}");
		process.env.PATH = "/nonexistent";
		const detections = await detectLspServers(dir);
		expect(detections).toHaveLength(0);
	});
});
