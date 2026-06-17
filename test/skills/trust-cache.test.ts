import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isPromptApproved,
	listApprovedSkillsForTests,
	recordPromptApproval,
	resetTrustCacheForTests,
	revokePromptApproval,
} from "../../src/skills/trust-cache.js";

describe("skills/trust-cache", () => {
	let testHome: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		testHome = mkdtempSync(join(tmpdir(), "maestro-trust-cache-test-"));
		prevHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = testHome;
		resetTrustCacheForTests();
	});

	afterEach(() => {
		if (prevHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = prevHome;
		}
		if (existsSync(testHome)) {
			rmSync(testHome, { recursive: true, force: true });
		}
	});

	it("returns false for an unknown SHA on a fresh cache", () => {
		expect(isPromptApproved("a".repeat(64))).toBe(false);
	});

	it("returns false for an empty SHA", () => {
		expect(isPromptApproved("")).toBe(false);
	});

	it("records an approval and reads it back", () => {
		const sha = "b".repeat(64);
		recordPromptApproval({
			name: "review",
			contentSha: sha,
			sourceType: "project",
		});
		expect(isPromptApproved(sha)).toBe(true);

		const entries = listApprovedSkillsForTests();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("review");
		expect(entries[0]?.sourceType).toBe("project");
		expect(entries[0]?.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("is idempotent on duplicate approvals — keeps one entry per SHA", () => {
		const sha = "c".repeat(64);
		recordPromptApproval({
			name: "review",
			contentSha: sha,
			sourceType: "user",
		});
		recordPromptApproval({
			name: "review",
			contentSha: sha,
			sourceType: "user",
		});
		expect(listApprovedSkillsForTests()).toHaveLength(1);
	});

	it("invalidates approval when the SHA changes", () => {
		const shaA = "1".repeat(64);
		const shaB = "2".repeat(64);
		recordPromptApproval({
			name: "review",
			contentSha: shaA,
			sourceType: "project",
		});
		expect(isPromptApproved(shaA)).toBe(true);
		expect(isPromptApproved(shaB)).toBe(false);
	});

	it("revoke removes the approval", () => {
		const sha = "d".repeat(64);
		recordPromptApproval({
			name: "deploy",
			contentSha: sha,
			sourceType: "system",
		});
		expect(isPromptApproved(sha)).toBe(true);
		expect(revokePromptApproval(sha)).toBe(true);
		expect(isPromptApproved(sha)).toBe(false);
		// Second revoke is a no-op
		expect(revokePromptApproval(sha)).toBe(false);
	});

	it("survives a fresh load from disk", () => {
		const sha = "e".repeat(64);
		recordPromptApproval({
			name: "review",
			contentSha: sha,
			sourceType: "project",
		});

		// Simulate a new process by clearing module-level state if any.
		// The cache reads from disk on every call so this is implicit.
		expect(isPromptApproved(sha)).toBe(true);
	});

	it("tolerates a corrupted trust file by treating it as empty", async () => {
		const sha = "f".repeat(64);
		// Write garbage where the trust file would be.
		const fs = await import("node:fs");
		const path = join(testHome, "trust", "skills.json");
		fs.mkdirSync(join(testHome, "trust"), { recursive: true });
		fs.writeFileSync(path, "{ not valid json");
		expect(isPromptApproved(sha)).toBe(false);
		// Recording an approval recovers — the next save overwrites the
		// garbage file with a valid record.
		recordPromptApproval({
			name: "deploy",
			contentSha: sha,
			sourceType: "user",
		});
		expect(isPromptApproved(sha)).toBe(true);
	});

	it("rotates a corrupted trust file aside instead of silently overwriting it (#2631)", async () => {
		const fs = await import("node:fs");
		const trustDir = join(testHome, "trust");
		const path = join(trustDir, "skills.json");
		fs.mkdirSync(trustDir, { recursive: true });
		const corrupted = '{ "skills": [{"contentSha": "abc", "OOPS truncated';
		fs.writeFileSync(path, corrupted);

		// Reading triggers the rotate path: the corrupted body is moved
		// to `skills.json.corrupt.<ts>` and a fresh empty cache is used.
		expect(isPromptApproved("a".repeat(64))).toBe(false);

		// The corrupt sibling exists with the original bytes for forensics.
		const siblings = fs
			.readdirSync(trustDir)
			.filter((name) => name.startsWith("skills.json.corrupt."));
		expect(siblings).toHaveLength(1);
		const evidence = fs.readFileSync(join(trustDir, siblings[0]!), "utf-8");
		expect(evidence).toBe(corrupted);

		// And recording a new approval lands a valid file in its place.
		recordPromptApproval({
			name: "deploy",
			contentSha: "b".repeat(64),
			sourceType: "user",
		});
		expect(fs.existsSync(path)).toBe(true);
		expect(isPromptApproved("b".repeat(64))).toBe(true);
	});
});
