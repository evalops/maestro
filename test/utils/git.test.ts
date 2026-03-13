import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getAheadBehind,
	getCommitSha,
	getCurrentBranch,
	getGitRoot,
	getGitState,
	isDirtyWorkingTree,
	isInsideGitRepository,
} from "../../src/utils/git.js";

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

describe("getCommitSha", () => {
	it("returns a 40-character SHA for the current project", () => {
		const sha = getCommitSha();

		expect(sha).toBeDefined();
		expect(sha).toHaveLength(40);
		expect(sha).toMatch(/^[a-f0-9]{40}$/);
	});

	it("returns undefined for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(getCommitSha(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getCurrentBranch", () => {
	it("returns a branch name for the current project", () => {
		const branch = getCurrentBranch();

		// In CI or detached HEAD, this might be undefined
		if (branch !== undefined) {
			expect(typeof branch).toBe("string");
			expect(branch.length).toBeGreaterThan(0);
		}
	});

	it("returns undefined for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(getCurrentBranch(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isDirtyWorkingTree", () => {
	it("returns a boolean for the current project", () => {
		const isDirty = isDirtyWorkingTree();

		expect(typeof isDirty).toBe("boolean");
	});

	it("returns false for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(isDirtyWorkingTree(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getAheadBehind", () => {
	it("returns ahead/behind or undefined for the current project", () => {
		const result = getAheadBehind();

		// May be undefined if no upstream is set
		if (result !== undefined) {
			expect(typeof result.ahead).toBe("number");
			expect(typeof result.behind).toBe("number");
			expect(typeof result.upstream).toBe("string");
			expect(result.ahead).toBeGreaterThanOrEqual(0);
			expect(result.behind).toBeGreaterThanOrEqual(0);
		}
	});

	it("returns undefined for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(getAheadBehind(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getGitState", () => {
	it("returns comprehensive state for the current project", () => {
		const state = getGitState();

		expect(state.isRepo).toBe(true);
		expect(state.commitSha).toBeDefined();
		expect(state.commitSha).toHaveLength(40);
		expect(state.shortSha).toBeDefined();
		expect(state.shortSha).toHaveLength(7);
		expect(typeof state.isDirty).toBe("boolean");

		// Branch and upstream may be undefined in certain conditions
		if (state.branch !== undefined) {
			expect(typeof state.branch).toBe("string");
		}
	});

	it("returns isRepo: false for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			const state = getGitState(dir);

			expect(state.isRepo).toBe(false);
			expect(state.commitSha).toBeUndefined();
			expect(state.branch).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("short SHA is the first 7 characters of full SHA", () => {
		const state = getGitState();

		if (state.commitSha && state.shortSha) {
			expect(state.commitSha.startsWith(state.shortSha)).toBe(true);
		}
	});
});

describe("getGitRoot", () => {
	it("returns the git root for the current project", () => {
		const root = getGitRoot();

		expect(root).toBeDefined();
		expect(root).toBe(process.cwd());
		expect(getGitRoot(root)).toBe(root);
	});

	it("returns undefined for non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(getGitRoot(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
