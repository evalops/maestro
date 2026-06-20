import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Checkpoint,
	formatCheckpoint,
	sessionCheckpoint,
} from "../../src/agent/session-checkpoint.js";

/**
 * The SessionCheckpointManager class is not exported; we drive the
 * `sessionCheckpoint` singleton. PATHS.MAESTRO_HOME reads process.env.MAESTRO_HOME
 * (a getter), so pointing it at a fresh tmpdir isolates the filesystem without
 * touching the real ~/.maestro. The singleton is reset via cleanup() between tests.
 */
let dir: string;
let originalHome: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ckpt-test-"));
	originalHome = process.env.MAESTRO_HOME;
	process.env.MAESTRO_HOME = dir;
	sessionCheckpoint.cleanup();
	vi.useFakeTimers();
});

afterEach(async () => {
	sessionCheckpoint.stopAutoCheckpoint();
	sessionCheckpoint.cleanup();
	vi.useRealTimers();
	if (originalHome === undefined) {
		delete process.env.MAESTRO_HOME;
	} else {
		process.env.MAESTRO_HOME = originalHome;
	}
	await rm(dir, { recursive: true, force: true });
});

async function init(
	config?: Parameters<typeof sessionCheckpoint.initialize>[1],
) {
	await sessionCheckpoint.initialize("sess-1", {
		autoCheckpoint: false,
		maxCheckpoints: 20,
		...config,
	});
}

describe("SessionCheckpointManager — initialization & guards", () => {
	it("throws when createCheckpoint is called before initialize()", async () => {
		await expect(
			sessionCheckpoint.createCheckpoint({ summary: "x" }),
		).rejects.toThrow("Checkpoint system not initialized");
	});

	it("initialize() resumes the sequence from existing checkpoints", async () => {
		await init({ maxCheckpoints: 20 });
		await sessionCheckpoint.createCheckpoint({ summary: "first" });
		await sessionCheckpoint.createCheckpoint({ summary: "second" });
		expect(sessionCheckpoint.getStats().totalCheckpoints).toBe(2);

		// re-initialize against the same session dir: sequence should continue
		sessionCheckpoint.cleanup();
		await init({ maxCheckpoints: 20 });
		const third = await sessionCheckpoint.createCheckpoint({
			summary: "third",
		});
		expect(third.sequence).toBe(3);
	});
});

describe("SessionCheckpointManager — createCheckpoint & persistence", () => {
	it("creates a checkpoint with the expected shape and sequence", async () => {
		await init();
		const cp = await sessionCheckpoint.createCheckpoint({
			summary: "did a thing",
			completedTasks: ["a"],
			pendingTasks: ["b"],
			currentTask: "c",
			context: { k: "v" },
			tokenUsage: { input: 10, output: 20, total: 30 },
		});
		expect(cp).toMatchObject({
			sessionId: "sess-1",
			sequence: 1,
			summary: "did a thing",
			completedTasks: ["a"],
			pendingTasks: ["b"],
			currentTask: "c",
			context: { k: "v" },
			tokenUsage: { total: 30 },
		});
		expect(cp.id).toMatch(/^ckpt_/);
		expect(cp.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(sessionCheckpoint.getStats().totalCheckpoints).toBe(1);
	});

	it("increments sequence across checkpoints and lists them in order", async () => {
		await init();
		await sessionCheckpoint.createCheckpoint({ summary: "1" });
		await sessionCheckpoint.createCheckpoint({ summary: "2" });
		await sessionCheckpoint.createCheckpoint({ summary: "3" });
		const list = await sessionCheckpoint.listCheckpoints();
		expect(list.map((c) => c.sequence)).toEqual([1, 2, 3]);
	});

	it("getLatest() returns the highest-sequence checkpoint", async () => {
		await init();
		await sessionCheckpoint.createCheckpoint({ summary: "1" });
		await sessionCheckpoint.createCheckpoint({ summary: "2" });
		const latest = await sessionCheckpoint.getLatest();
		expect(latest?.sequence).toBe(2);
	});

	it("getLatest() returns null when there are no checkpoints", async () => {
		await init();
		expect(await sessionCheckpoint.getLatest()).toBeNull();
	});

	it("getById() finds a checkpoint and returns null for unknown ids", async () => {
		await init();
		const cp = await sessionCheckpoint.createCheckpoint({ summary: "x" });
		expect((await sessionCheckpoint.getById(cp.id))?.id).toBe(cp.id);
		expect(await sessionCheckpoint.getById("does-not-exist")).toBeNull();
	});
});

describe("SessionCheckpointManager — pruning (maxCheckpoints)", () => {
	it("keeps only the newest N checkpoints", async () => {
		await init({ maxCheckpoints: 2 });
		for (let i = 1; i <= 4; i++) {
			await sessionCheckpoint.createCheckpoint({ summary: `cp-${i}` });
		}
		const list = await sessionCheckpoint.listCheckpoints();
		expect(list).toHaveLength(2);
		// newest two survive
		expect(list.map((c) => c.sequence)).toEqual([3, 4]);
		const latest = await sessionCheckpoint.getLatest();
		expect(latest?.sequence).toBe(4);
	});

	it("keeps everything when under the limit", async () => {
		await init({ maxCheckpoints: 20 });
		await sessionCheckpoint.createCheckpoint({ summary: "a" });
		await sessionCheckpoint.createCheckpoint({ summary: "b" });
		expect(await sessionCheckpoint.listCheckpoints()).toHaveLength(2);
	});
});

describe("SessionCheckpointManager — task / file / error tracking", () => {
	it("markTaskComplete moves a task from pending to completed and clears currentTask", async () => {
		await init();
		sessionCheckpoint.addPendingTasks(["t1", "t2"]);
		sessionCheckpoint.addPendingTasks(["t1"]); // dedup
		sessionCheckpoint.setCurrentTask("t1");
		sessionCheckpoint.markTaskComplete("t1");
		const stats = sessionCheckpoint.getStats();
		expect(stats.pendingTasks).toBe(1);
		expect(stats.completedTasks).toBe(1);
	});

	it("createCheckpoint snapshots tracked state when fields are omitted", async () => {
		await init();
		sessionCheckpoint.addPendingTasks(["p1"]);
		sessionCheckpoint.setCurrentTask("cur");
		sessionCheckpoint.markTaskComplete("done");
		const cp = await sessionCheckpoint.createCheckpoint({ summary: "s" });
		expect(cp.pendingTasks).toEqual(["p1"]);
		expect(cp.currentTask).toBe("cur");
		expect(cp.completedTasks).toEqual(["done"]);
	});

	it("captures modifiedFiles and errors, then clears them after a checkpoint", async () => {
		await init();
		sessionCheckpoint.trackFileModification("/a.ts");
		sessionCheckpoint.trackFileModification("/b.ts");
		sessionCheckpoint.trackError("boom");
		const cp = await sessionCheckpoint.createCheckpoint({ summary: "s" });
		expect(cp.modifiedFiles).toEqual(["/a.ts", "/b.ts"]);
		expect(cp.errors).toEqual(["boom"]);
		// cleared after checkpoint
		expect(sessionCheckpoint.getStats().modifiedFiles).toBe(0);
		expect(sessionCheckpoint.getStats().errors).toBe(0);
	});

	it("omits modifiedFiles when trackFileChanges is disabled", async () => {
		await init({ trackFileChanges: false });
		sessionCheckpoint.trackFileModification("/a.ts");
		const cp = await sessionCheckpoint.createCheckpoint({ summary: "s" });
		expect(cp.modifiedFiles).toBeUndefined();
	});

	it("caps tracked errors at 20", async () => {
		await init();
		for (let i = 0; i < 25; i++) {
			sessionCheckpoint.trackError(`err-${i}`);
		}
		expect(sessionCheckpoint.getStats().errors).toBe(20);
	});
});

describe("SessionCheckpointManager — auto-checkpoint timer", () => {
	it("fires on the interval and writes checkpoints", async () => {
		await init({ autoCheckpoint: true, intervalMs: 1000 });
		expect(await sessionCheckpoint.getLatest()).toBeNull();

		await vi.advanceTimersByTimeAsync(1000);
		expect((await sessionCheckpoint.getLatest())?.summary).toBe(
			"Auto-checkpoint",
		);

		await vi.advanceTimersByTimeAsync(1000);
		const list = await sessionCheckpoint.listCheckpoints();
		expect(list).toHaveLength(2);
	});

	it("stopAutoCheckpoint() halts further checkpoints", async () => {
		await init({ autoCheckpoint: true, intervalMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await sessionCheckpoint.listCheckpoints()).toHaveLength(1);

		sessionCheckpoint.stopAutoCheckpoint();
		await vi.advanceTimersByTimeAsync(5000);
		expect(await sessionCheckpoint.listCheckpoints()).toHaveLength(1);
	});

	it("does not start the timer when autoCheckpoint is disabled", async () => {
		await init({ autoCheckpoint: false, intervalMs: 1000 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(await sessionCheckpoint.listCheckpoints()).toEqual([]);
	});
});

describe("SessionCheckpointManager — resume prompt & formatting", () => {
	it("generateResumePrompt() renders sections from the latest checkpoint", async () => {
		await init();
		sessionCheckpoint.addPendingTasks(["ship it"]);
		sessionCheckpoint.setCurrentTask("verify");
		await sessionCheckpoint.createCheckpoint({
			summary: "mid-flight",
			completedTasks: ["design"],
			context: {},
		});
		const prompt = await sessionCheckpoint.generateResumePrompt();
		expect(prompt).toContain("## Session Resume Context");
		expect(prompt).toContain("mid-flight");
		expect(prompt).toContain("### Completed Tasks");
		expect(prompt).toContain("- ✅ design");
		expect(prompt).toContain("### Pending Tasks");
		expect(prompt).toContain("### Current Task: verify");
	});

	it("generateResumePrompt() returns null when there are no checkpoints", async () => {
		await init();
		expect(await sessionCheckpoint.generateResumePrompt()).toBeNull();
	});

	it("formatCheckpoint() renders a compact display string", () => {
		const cp: Checkpoint = {
			id: "ckpt_x",
			sessionId: "s",
			timestamp: "2026-01-01T00:00:00.000Z",
			sequence: 7,
			summary: "hello",
			completedTasks: ["a", "b"],
			pendingTasks: ["c"],
			currentTask: "c",
			context: {},
			modifiedFiles: ["/x"],
		};
		const out = formatCheckpoint(cp);
		expect(out).toContain("Checkpoint #7: hello");
		expect(out).toContain("Completed: 2 tasks");
		expect(out).toContain("Current: c");
		expect(out).toContain("Files modified: 1");
	});
});

describe("SessionCheckpointManager — cleanup", () => {
	it("cleanup() resets all state so createCheckpoint guards again", async () => {
		await init();
		await sessionCheckpoint.createCheckpoint({ summary: "x" });
		expect(sessionCheckpoint.getStats().totalCheckpoints).toBe(1);
		sessionCheckpoint.cleanup();
		expect(sessionCheckpoint.getStats().totalCheckpoints).toBe(0);
		await expect(
			sessionCheckpoint.createCheckpoint({ summary: "y" }),
		).rejects.toThrow("Checkpoint system not initialized");
	});
});
