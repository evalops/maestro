import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getAheadBehind,
	getCommitSha,
	getCurrentBranch,
	getGitRoot,
	getGitSnapshot,
	getGitState,
	isDirtyWorkingTree,
	isInsideGitRepository,
} from "../../src/utils/git.js";

function initGitRepo(directory: string): void {
	execSync("git init", { cwd: directory, stdio: "ignore" });
	execSync('git config user.email "test@example.com"', {
		cwd: directory,
		stdio: "ignore",
	});
	execSync('git config user.name "Test User"', {
		cwd: directory,
		stdio: "ignore",
	});
}

function commitFile(
	directory: string,
	fileName: string,
	content: string,
	message: string,
): void {
	writeFileSync(join(directory, fileName), content);
	execSync(`git add ${fileName}`, { cwd: directory, stdio: "ignore" });
	execSync(`git commit -m "${message}"`, { cwd: directory, stdio: "ignore" });
}

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

describe("getGitSnapshot", () => {
	it("returns null outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-non-git-"));
		try {
			expect(getGitSnapshot(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("formats a repository snapshot with status and recent commits", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-git-snapshot-"));

		try {
			initGitRepo(dir);
			commitFile(dir, "tracked.txt", "tracked\n", "initial commit");
			writeFileSync(join(dir, "modified.txt"), "pending change\n");

			const snapshot = getGitSnapshot(dir);

			expect(snapshot).toContain("# Repository Snapshot");
			expect(snapshot).toContain("Current branch:");
			expect(snapshot).toContain("Working tree: dirty");
			expect(snapshot).toContain("Status:");
			expect(snapshot).toContain("modified.txt");
			expect(snapshot).toContain("Recent commits:");
			expect(snapshot).toContain("initial commit");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("truncates large git status snapshots", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-git-snapshot-"));

		try {
			initGitRepo(dir);
			commitFile(dir, "tracked.txt", "tracked\n", "initial commit");
			for (let i = 0; i < 20; i++) {
				writeFileSync(join(dir, `file-${i}.txt`), `change ${i}\n`);
			}

			const snapshot = getGitSnapshot(dir, { maxStatusChars: 40 });

			expect(snapshot).toContain("truncated because it exceeds 40 characters");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports git log failures separately from empty history", () => {
		const dir = mkdtempSync(join(tmpdir(), "composer-git-snapshot-"));
		const binDir = mkdtempSync(join(tmpdir(), "composer-fake-git-bin-"));
		const gitPath = join(binDir, "git");
		const originalPath = process.env.PATH;

		try {
			writeFileSync(
				gitPath,
				`#!/bin/sh
args="$*"
case "$args" in
  "rev-parse --is-inside-work-tree")
    printf 'true\\n'
    exit 0
    ;;
  "rev-parse HEAD")
    printf '0123456789abcdef0123456789abcdef01234567\\n'
    exit 0
    ;;
  "rev-parse --abbrev-ref HEAD")
    printf 'main\\n'
    exit 0
    ;;
  "rev-parse --abbrev-ref --symbolic-full-name @{u}")
    exit 1
    ;;
  "status --porcelain")
    exit 0
    ;;
  "--no-optional-locks status --short")
    printf ' M tracked.txt\\n'
    exit 0
    ;;
  "--no-optional-locks log --oneline -n 5")
    printf 'fatal: cannot read log\\n' >&2
    exit 1
    ;;
esac

printf 'unexpected args: %s\\n' "$args" >&2
exit 1
`,
			);
			chmodSync(gitPath, 0o755);
			process.env.PATH = `${binDir}:${originalPath ?? ""}`;

			const snapshot = getGitSnapshot(dir);

			expect(snapshot).toContain("Status:\nM tracked.txt");
			expect(snapshot).toContain("Recent commits:\n(git log unavailable)");
		} finally {
			if (originalPath === undefined) {
				Reflect.deleteProperty(process.env, "PATH");
			} else {
				process.env.PATH = originalPath;
			}
			rmSync(binDir, { recursive: true, force: true });
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
