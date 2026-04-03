import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readWorkspaceFile } from "../../src/headless/utility-file-read.js";

describe("readWorkspaceFile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads paginated text content inside the requested cwd", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-read-"));
		try {
			const filePath = join(tempDir, "notes.txt");
			await writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");

			const result = await readWorkspaceFile({
				path: "notes.txt",
				cwd: tempDir,
				offset: 2,
				limit: 2,
			});

			expect(result).toEqual({
				path: filePath,
				relative_path: "notes.txt",
				cwd: tempDir,
				content: "two\nthree",
				start_line: 2,
				end_line: 3,
				total_lines: 4,
				truncated: true,
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects traversal outside the requested cwd", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "maestro-headless-read-"));
		const outsideDir = await mkdtemp(
			join(tmpdir(), "maestro-headless-outside-"),
		);
		try {
			await writeFile(join(outsideDir, "secret.txt"), "hidden", "utf8");

			await expect(
				readWorkspaceFile({
					path: "../secret.txt",
					cwd: rootDir,
				}),
			).rejects.toThrow(/Path traversal detected/);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
			await rm(outsideDir, { recursive: true, force: true });
		}
	});
});
