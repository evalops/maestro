import { afterEach, describe, expect, it, vi } from "vitest";

describe("getWorkspaceFiles", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("node:child_process");
	});

	it("evicts old cwd cache entries instead of growing without bound", async () => {
		const spawnSync = vi.fn(
			(_command: string, _args: string[], options?: { cwd?: string }) => ({
				status: 0,
				stdout: `${options?.cwd ?? "unknown"}/file.ts\n`,
			}),
		);
		vi.doMock("node:child_process", () => ({ spawnSync }));

		const { getWorkspaceFiles, WORKSPACE_FILES_MAX_CACHE_ENTRIES } =
			await import("../../src/utils/workspace-files.js");

		for (
			let index = 0;
			index <= WORKSPACE_FILES_MAX_CACHE_ENTRIES;
			index += 1
		) {
			getWorkspaceFiles(10, `/tmp/workspace-${index}`);
		}

		expect(spawnSync).toHaveBeenCalledTimes(
			WORKSPACE_FILES_MAX_CACHE_ENTRIES + 1,
		);

		getWorkspaceFiles(10, "/tmp/workspace-0");

		expect(spawnSync).toHaveBeenCalledTimes(
			WORKSPACE_FILES_MAX_CACHE_ENTRIES + 2,
		);
	});
});
