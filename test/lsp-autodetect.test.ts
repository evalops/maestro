import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
		const prevPath = process.env.PATH;
		try {
			process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
			const detections = await detectLspServers(dir);
			const ts = detections.find((d) => d.serverId === "typescript");
			expect(ts?.root).toBe(dir);
		} finally {
			process.env.PATH = prevPath;
		}
	});

	it("skips when binary missing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "package-lock.json"), "{}");
		const prevPath = process.env.PATH;
		try {
			process.env.PATH = "/nonexistent";
			const detections = await detectLspServers(dir);
			expect(detections).toHaveLength(0);
		} finally {
			process.env.PATH = prevPath;
		}
	});

	it("searches beyond process.cwd for lockfiles", async () => {
		const root = tempDir();
		const workspace = join(root, "workspace");
		const project = join(workspace, "project");
		const nested = join(project, "nested");
		const deep = join(nested, "deep");
		for (const dirPath of [workspace, project, nested, deep]) {
			mkdirSync(dirPath, { recursive: true });
		}
		writeFileSync(join(workspace, "package-lock.json"), "{}");
		const fakeBinDir = tempDir();
		const fakeTs = join(fakeBinDir, "typescript-language-server");
		writeFileSync(fakeTs, "#!/bin/sh\nexit 0\n");
		chmodSync(fakeTs, 0o755);
		const prevCwd = process.cwd();
		const prevPath = process.env.PATH;
		try {
			process.chdir(project);
			const delimiter = process.platform === "win32" ? ";" : ":";
			process.env.PATH = `${fakeBinDir}${delimiter}${prevPath ?? ""}`;
			const detections = await detectLspServers(deep);
			expect(detections.find((d) => d.serverId === "typescript")?.root).toBe(
				workspace,
			);
		} finally {
			process.chdir(prevCwd);
			process.env.PATH = prevPath;
		}
	});

	it("detects Windows binaries with .cmd suffix", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "package-lock.json"), "{}");
		const binDir = tempDir();
		const fakeTsCmd = join(binDir, "typescript-language-server.cmd");
		writeFileSync(fakeTsCmd, "@echo off\r\nexit /b 0\r\n");
		const prevPath = process.env.PATH;
		const platformSpy = vi.spyOn(process, "platform", "get");
		platformSpy.mockReturnValue("win32");
		try {
			process.env.PATH = `${binDir};${prevPath ?? ""}`;
			const detections = await detectLspServers(dir);
			expect(detections.some((d) => d.serverId === "typescript")).toBe(true);
		} finally {
			process.env.PATH = prevPath;
			platformSpy.mockRestore();
		}
	});
});
