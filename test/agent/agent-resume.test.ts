import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentTranscript,
	type AppMessage,
	FileTranscriptStore,
	MemoryTranscriptStore,
	buildResumePrompt,
	completeTranscript,
	createTranscript,
	failTranscript,
	getDefaultTranscriptStore,
	getTranscriptSummary,
	setDefaultTranscriptStore,
	updateTranscript,
} from "../../src/agent/agent-resume.js";

const fixedClock = () => ({ now: () => 1_000 });
const seqClock = () => {
	const state = { t: 1_000 };
	return {
		now: () => state.t,
		tick: (by = 100) => {
			state.t += by;
		},
	};
};
const fixedIds = () => ({ uuid: () => "fixed-id" });

function baseTranscript(
	overrides: Partial<AgentTranscript> = {},
): AgentTranscript {
	return {
		id: "t1",
		agentType: "explore",
		startedAt: 1000,
		updatedAt: 1000,
		originalPrompt: "explore the repo",
		systemPrompt: "be thorough",
		model: "test-model",
		messages: [],
		completed: false,
		...overrides,
	};
}

const userMsg = (text: string): AppMessage =>
	({ role: "user", content: text }) as AppMessage;
const assistantMsg = (text: string): AppMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
	}) as AppMessage;

describe("transcript factories", () => {
	it("createTranscript() shapes a fresh transcript with injected clock/id", () => {
		const t = createTranscript(
			"review",
			"do the thing",
			"sys",
			"claude-x",
			{ repo: "r" },
			{
				clock: fixedClock(),
				idGenerator: fixedIds(),
			},
		);
		expect(t).toMatchObject({
			id: "fixed-id",
			agentType: "review",
			originalPrompt: "do the thing",
			systemPrompt: "sys",
			model: "claude-x",
			startedAt: 1000,
			updatedAt: 1000,
			messages: [],
			completed: false,
		});
		expect(t.metadata).toEqual({ repo: "r" });
		expect(t.startedAt).toBe(t.updatedAt);
	});

	it("updateTranscript() replaces messages and bumps updatedAt", () => {
		const clock = seqClock();
		const t = createTranscript("explore", "p", "s", "m", undefined, {
			clock,
			idGenerator: fixedIds(),
		});
		clock.tick();
		const updated = updateTranscript(t, [userMsg("hi")], { clock });
		expect(updated.messages).toHaveLength(1);
		expect(updated.updatedAt).toBe(1100);
		// original is not mutated
		expect(t.messages).toHaveLength(0);
		expect(t.updatedAt).toBe(1000);
	});

	it("completeTranscript() / failTranscript() mark completion and set terminal fields", () => {
		const clock = seqClock();
		const t = createTranscript("explore", "p", "s", "m", undefined, {
			clock,
			idGenerator: fixedIds(),
		});
		clock.tick();
		const done = completeTranscript(t, "all good", { clock });
		expect(done.completed).toBe(true);
		expect(done.result).toBe("all good");
		expect(done.error).toBeUndefined();

		clock.tick();
		const failed = failTranscript(done, "boom", { clock });
		expect(failed.completed).toBe(true);
		expect(failed.error).toBe("boom");
		// result is preserved from the prior completion (spread)
		expect(failed.result).toBe("all good");
	});
});

describe("MemoryTranscriptStore", () => {
	let store: MemoryTranscriptStore;
	beforeEach(() => {
		store = new MemoryTranscriptStore();
	});

	it("save/load round-trips a transcript by id", async () => {
		await store.save(baseTranscript({ id: "a" }));
		const loaded = await store.load("a");
		expect(loaded?.id).toBe("a");
	});

	it("load() returns null for an unknown id", async () => {
		expect(await store.load("missing")).toBeNull();
	});

	it("save() overwrites on duplicate id", async () => {
		await store.save(baseTranscript({ id: "a", originalPrompt: "first" }));
		await store.save(baseTranscript({ id: "a", originalPrompt: "second" }));
		const loaded = await store.load("a");
		expect(loaded?.originalPrompt).toBe("second");
	});

	it("list() returns transcripts ordered by updatedAt descending", async () => {
		await store.save(baseTranscript({ id: "old", updatedAt: 1000 }));
		await store.save(baseTranscript({ id: "new", updatedAt: 5000 }));
		await store.save(baseTranscript({ id: "mid", updatedAt: 3000 }));
		const ordered = await store.list();
		expect(ordered.map((t) => t.id)).toEqual(["new", "mid", "old"]);
	});

	it("list() filters by agentType", async () => {
		await store.save(baseTranscript({ id: "a", agentType: "explore" }));
		await store.save(baseTranscript({ id: "b", agentType: "review" }));
		await store.save(baseTranscript({ id: "c", agentType: "explore" }));
		const explores = await store.list({ agentType: "explore" });
		expect(explores.map((t) => t.id).sort()).toEqual(["a", "c"]);
	});

	it("list() respects the limit (after ordering)", async () => {
		await store.save(baseTranscript({ id: "a", updatedAt: 1 }));
		await store.save(baseTranscript({ id: "b", updatedAt: 2 }));
		await store.save(baseTranscript({ id: "c", updatedAt: 3 }));
		const top2 = await store.list({ limit: 2 });
		expect(top2).toHaveLength(2);
		expect(top2.map((t) => t.id)).toEqual(["c", "b"]);
	});

	it("delete() removes a transcript and is a no-op for unknown ids", async () => {
		await store.save(baseTranscript({ id: "a" }));
		await store.delete("a");
		expect(await store.load("a")).toBeNull();
		await expect(store.delete("never-existed")).resolves.toBeUndefined();
	});

	it("clear() empties the store", async () => {
		await store.save(baseTranscript({ id: "a" }));
		store.clear();
		expect(await store.list()).toEqual([]);
	});
});

describe("FileTranscriptStore", () => {
	let dir: string;
	let store: FileTranscriptStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "transcript-test-"));
		store = new FileTranscriptStore(dir);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("save/load round-trips through real disk", async () => {
		await store.save(
			baseTranscript({ id: "disk-1", originalPrompt: "persist me" }),
		);
		const loaded = await store.load("disk-1");
		expect(loaded?.originalPrompt).toBe("persist me");
	});

	it("load() returns null when the file is absent", async () => {
		expect(await store.load("nope")).toBeNull();
	});

	it("persists across store instances (real durability)", async () => {
		await store.save(baseTranscript({ id: "durable", updatedAt: 9000 }));
		const reopened = new FileTranscriptStore(dir);
		const loaded = await reopened.load("durable");
		expect(loaded?.id).toBe("durable");
	});

	it("list() orders by updatedAt descending and respects limit", async () => {
		await store.save(baseTranscript({ id: "a", updatedAt: 1000 }));
		await store.save(baseTranscript({ id: "b", updatedAt: 4000 }));
		await store.save(baseTranscript({ id: "c", updatedAt: 2000 }));
		const ordered = await store.list({ limit: 2 });
		expect(ordered.map((t) => t.id)).toEqual(["b", "c"]);
	});

	it("list() filters by agentType", async () => {
		await store.save(baseTranscript({ id: "a", agentType: "explore" }));
		await store.save(baseTranscript({ id: "b", agentType: "review" }));
		const reviews = await store.list({ agentType: "review" });
		expect(reviews.map((t) => t.id)).toEqual(["b"]);
	});

	it("list() returns [] when the directory does not exist", async () => {
		const orphan = new FileTranscriptStore(join(dir, "no-such-subdir"));
		await expect(orphan.list()).resolves.toEqual([]);
	});

	it("delete() removes the file and is a no-op for unknown ids", async () => {
		await store.save(baseTranscript({ id: "gone" }));
		await store.delete("gone");
		expect(await store.load("gone")).toBeNull();
		await expect(store.delete("gone")).resolves.toBeUndefined();
	});
});

describe("getTranscriptSummary / buildResumePrompt", () => {
	it("summarizes header, result, and recent conversation", () => {
		const t = baseTranscript({
			completed: true,
			result: "shipped it",
			messages: [userMsg("do x"), assistantMsg("done"), userMsg("thanks")],
		});
		const summary = getTranscriptSummary(t);
		expect(summary).toContain("## Previous explore Agent Session");
		expect(summary).toContain("Original Task: explore the repo");
		expect(summary).toContain("### Previous Result:");
		expect(summary).toContain("shipped it");
		expect(summary).toContain("**User:** do x");
		expect(summary).toContain("**Assistant:** done");
	});

	it("omits the result section when not completed", () => {
		const summary = getTranscriptSummary(baseTranscript());
		expect(summary).not.toContain("### Previous Result:");
	});

	it("truncates long message content at 500 chars", () => {
		const long = "x".repeat(600);
		const summary = getTranscriptSummary(
			baseTranscript({ messages: [userMsg(long)] }),
		);
		expect(summary).toContain("...");
		expect(summary).toContain("x".repeat(500));
		expect(summary).not.toContain("x".repeat(600));
	});

	it("buildResumePrompt() appends the continuation request", () => {
		const prompt = buildResumePrompt(
			baseTranscript({ result: "r" }),
			"and then?",
		);
		expect(prompt).toContain("## Continuation Request");
		expect(prompt).toContain("and then?");
		expect(prompt).toContain(
			"continue from where the previous session left off",
		);
	});
});

describe("default store", () => {
	it("getDefaultTranscriptStore() returns whatever was set", () => {
		const memory = new MemoryTranscriptStore();
		setDefaultTranscriptStore(memory);
		expect(getDefaultTranscriptStore()).toBe(memory);
	});
});
