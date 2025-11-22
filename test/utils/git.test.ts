import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideGitRepository } from "../../src/utils/git.js";

describe("isInsideGitRepository", () => {
	it("returns true when inside a git repository", () => {
		const directory = mkdtempSync(join(tmpdir(), "composer-git-utils-"));

		try {
			execSync("git init", { cwd: directory, stdio: "ignore" });
			expect(isInsideGitRepository(directory)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("returns false when outside a git repository", () => {
		const ceilingDirectory = mkdtempSync(join(tmpdir(), "composer-git-utils-"));
		const directory = mkdtempSync(join(ceilingDirectory, "non-repo-"));
		const originalCeilingDirectories = process.env.GIT_CEILING_DIRECTORIES;

		try {
			process.env.GIT_CEILING_DIRECTORIES = ceilingDirectory;
			expect(isInsideGitRepository(directory)).toBe(false);
		} finally {
			if (originalCeilingDirectories === undefined) {
				Reflect.deleteProperty(process.env, "GIT_CEILING_DIRECTORIES");
			} else {
				process.env.GIT_CEILING_DIRECTORIES = originalCeilingDirectories;
			}

			rmSync(ceilingDirectory, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
