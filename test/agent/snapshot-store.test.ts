import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RewindPlan } from "../../src/agent/snapshot-rewind-plan.js";
import {
	SnapshotBlobStore,
	executeRewindPlan,
} from "../../src/agent/snapshot-store.js";

describe("agent/snapshot-store", () => {
	it("executes rewind plans against a content-addressed blob store", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("old content");
		writeFileSync(join(workspaceDir, "delete-me.txt"), "new file");
		writeFileSync(join(workspaceDir, "restore-me.txt"), "new content");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{ kind: "delete", path: "delete-me.txt" },
				{
					kind: "restore",
					path: "restore-me.txt",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 1,
				bytesRestored: blob.size,
			},
		};

		const result = executeRewindPlan({ plan, workspaceDir, store });

		expect(result).toMatchObject({
			restored: ["restore-me.txt"],
			deleted: ["delete-me.txt"],
			bytesRestored: blob.size,
		});
		expect(existsSync(join(workspaceDir, "delete-me.txt"))).toBe(false);
		expect(readFileSync(join(workspaceDir, "restore-me.txt"), "utf-8")).toBe(
			"old content",
		);
	});

	it("prunes empty directories that block rewind file restores", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("restored file");
		mkdirSync(join(workspaceDir, "replace-me"), { recursive: true });
		writeFileSync(join(workspaceDir, "replace-me", "child.txt"), "new child");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{ kind: "delete", path: "replace-me/child.txt" },
				{
					kind: "restore",
					path: "replace-me",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 1,
				bytesRestored: blob.size,
			},
		};

		executeRewindPlan({ plan, workspaceDir, store });

		expect(readFileSync(join(workspaceDir, "replace-me"), "utf-8")).toBe(
			"restored file",
		);
	});

	it("preflights unplanned directory contents before rewind restores mutate", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("restored file");
		mkdirSync(join(workspaceDir, "replace-me"), { recursive: true });
		writeFileSync(join(workspaceDir, "replace-me", "delete.txt"), "delete me");
		writeFileSync(join(workspaceDir, "replace-me", "keep.txt"), "keep me");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{ kind: "delete", path: "replace-me/delete.txt" },
				{
					kind: "restore",
					path: "replace-me",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 1,
				bytesRestored: blob.size,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"rewind restore target is blocked by unplanned workspace entry: replace-me",
		);
		expect(
			readFileSync(join(workspaceDir, "replace-me", "delete.txt"), "utf-8"),
		).toBe("delete me");
		expect(
			readFileSync(join(workspaceDir, "replace-me", "keep.txt"), "utf-8"),
		).toBe("keep me");
	});

	it("rejects rewind plan paths outside the workspace", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("old content");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{
					kind: "restore",
					path: "../outside.txt",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 0,
				bytesRestored: blob.size,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"rewind plan path escapes workspace: ../outside.txt",
		);
	});

	it("rejects Windows-style parent directory rewind paths", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("old content");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{
					kind: "restore",
					path: "..\\outside.txt",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 0,
				bytesRestored: blob.size,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"rewind plan path escapes workspace: ..\\outside.txt",
		);
	});

	it("allows rewind plan paths whose workspace-relative names start with two dots", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("dotted content");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{
					kind: "restore",
					path: "..foo/restored.txt",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 0,
				bytesRestored: blob.size,
			},
		};

		executeRewindPlan({ plan, workspaceDir, store });

		expect(
			readFileSync(join(workspaceDir, "..foo", "restored.txt"), "utf-8"),
		).toBe("dotted content");
	});

	it("preflights restore blobs before mutating workspace files", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		writeFileSync(join(workspaceDir, "delete-me.txt"), "keep until valid");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{ kind: "delete", path: "delete-me.txt" },
				{
					kind: "restore",
					path: "restore-me.txt",
					contentSha256: "0".repeat(64),
					size: 12,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 1,
				bytesRestored: 12,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"snapshot blob not found",
		);
		expect(readFileSync(join(workspaceDir, "delete-me.txt"), "utf-8")).toBe(
			"keep until valid",
		);
	});

	it("rejects non-hex snapshot blob identifiers", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-rewind-work-"));
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 3,
			ops: [
				{
					kind: "restore",
					path: "restore-me.txt",
					contentSha256: "../../../outside",
					size: 7,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 0,
				bytesRestored: 7,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"invalid snapshot blob sha256",
		);
	});

	it("rejects rewind ops that escape the workspace", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-rewind-root-"));
		const workspaceDir = join(rootDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		const outsidePath = join(rootDir, "outside.txt");
		writeFileSync(outsidePath, "keep me");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 2,
			ops: [{ kind: "delete", path: "../outside.txt" }],
			summary: {
				restoreCount: 0,
				deleteCount: 1,
				bytesRestored: 0,
			},
		};

		expect(() =>
			executeRewindPlan({
				plan,
				workspaceDir,
			}),
		).toThrow("rewind plan path escapes workspace");
		expect(readFileSync(outsidePath, "utf-8")).toBe("keep me");
	});

	it("rejects rewind ops that escape through workspace symlinks", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-rewind-root-"));
		const workspaceDir = join(rootDir, "workspace");
		const outsideDir = join(rootDir, "outside");
		const blobDir = mkdtempSync(join(tmpdir(), "maestro-rewind-blobs-"));
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		symlinkSync(outsideDir, join(workspaceDir, "linked-out"));
		const store = new SnapshotBlobStore({ rootDir: blobDir });
		const blob = store.put("outside write");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 2,
			ops: [
				{
					kind: "restore",
					path: "linked-out/restored.txt",
					contentSha256: blob.contentSha256,
					size: blob.size,
				},
			],
			summary: {
				restoreCount: 1,
				deleteCount: 0,
				bytesRestored: blob.size,
			},
		};

		expect(() => executeRewindPlan({ plan, workspaceDir, store })).toThrow(
			"rewind plan path escapes workspace",
		);
		expect(existsSync(join(outsideDir, "restored.txt"))).toBe(false);
	});

	it("rejects rewinds through symlinked workspace directories", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "maestro-rewind-root-"));
		const workspaceDir = join(rootDir, "workspace");
		const outsideDir = join(rootDir, "outside");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "secret.txt"), "keep me");
		symlinkSync(outsideDir, join(workspaceDir, "linked"), "dir");
		const plan: RewindPlan = {
			targetIndex: 1,
			fromIndex: 2,
			ops: [{ kind: "delete", path: "linked/secret.txt" }],
			summary: {
				restoreCount: 0,
				deleteCount: 1,
				bytesRestored: 0,
			},
		};

		expect(() =>
			executeRewindPlan({
				plan,
				workspaceDir,
			}),
		).toThrow("rewind plan path escapes workspace");
		expect(readFileSync(join(outsideDir, "secret.txt"), "utf-8")).toBe(
			"keep me",
		);
	});
});
