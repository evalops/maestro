import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RequestContext,
	type SessionAccessControl,
	SessionAccessDeniedError,
	resetSessionAccessControlForTests,
	setSessionAccessControl,
} from "../../src/server/access-control.js";
import { HostedSessionManager } from "../../src/server/hosted-session-manager.js";

vi.mock("../../src/db/client.js", () => ({
	getDb: vi.fn(() => ({
		update: vi.fn(() => ({
			set: vi.fn(() => ({
				where: vi.fn(async () => undefined),
			})),
		})),
	})),
}));

/**
 * These tests verify the access-control gate is wired into
 * HostedSessionManager's read/write surface methods. The test does NOT
 * touch the database — it relies on the gate firing *before* any DB
 * call, so a stub that throws will surface the throw without ever
 * reaching getDb().
 *
 * See #2641.
 */

class DenyingAccessControl implements SessionAccessControl {
	public reads: string[] = [];
	public writes: string[] = [];
	async assertSessionReadable(
		sessionId: string,
		_ctx: RequestContext,
	): Promise<void> {
		this.reads.push(sessionId);
		throw new SessionAccessDeniedError(sessionId, "stub-denies");
	}
	async assertSessionWritable(
		sessionId: string,
		_ctx: RequestContext,
	): Promise<void> {
		this.writes.push(sessionId);
		throw new SessionAccessDeniedError(sessionId, "stub-denies");
	}
	assertSessionReadableSync(sessionId: string, _ctx: RequestContext): void {
		this.reads.push(sessionId);
		throw new SessionAccessDeniedError(sessionId, "stub-denies");
	}
	assertSessionWritableSync(sessionId: string, _ctx: RequestContext): void {
		this.writes.push(sessionId);
		throw new SessionAccessDeniedError(sessionId, "stub-denies");
	}
}

describe("HostedSessionManager × SessionAccessControl", () => {
	let stub: DenyingAccessControl;
	let manager: HostedSessionManager;

	beforeEach(() => {
		stub = new DenyingAccessControl();
		setSessionAccessControl(stub);
		manager = new HostedSessionManager({ scope: "test-scope" });
	});

	afterEach(() => {
		resetSessionAccessControlForTests();
	});

	it("loadSession invokes the readable gate before any DB call", async () => {
		await expect(manager.loadSession("sess-r1")).rejects.toBeInstanceOf(
			SessionAccessDeniedError,
		);
		expect(stub.reads).toContain("sess-r1");
		expect(stub.writes).toEqual([]);
	});

	it("loadEntries invokes the readable gate", async () => {
		await expect(manager.loadEntries("sess-r2")).rejects.toBeInstanceOf(
			SessionAccessDeniedError,
		);
		expect(stub.reads).toContain("sess-r2");
	});

	it("resumeSession invokes the readable gate", async () => {
		await expect(manager.resumeSession("sess-r3")).rejects.toBeInstanceOf(
			SessionAccessDeniedError,
		);
		expect(stub.reads).toContain("sess-r3");
	});

	it("deleteSession invokes the writable gate", async () => {
		await expect(manager.deleteSession("sess-w1")).rejects.toBeInstanceOf(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-w1");
		expect(stub.reads).toEqual([]);
	});

	it("updateSessionMetadata invokes the writable gate", async () => {
		await expect(
			manager.updateSessionMetadata("sess-w2", { title: "x" }),
		).rejects.toBeInstanceOf(SessionAccessDeniedError);
		expect(stub.writes).toContain("sess-w2");
	});

	it("read methods do not invoke the writable gate", async () => {
		await expect(manager.loadSession("sess-r4")).rejects.toBeInstanceOf(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toEqual([]);
	});

	// Methods gated in the adversarial-review batch 2 follow-up:

	it("setSessionFavorite invokes the sync writable gate", () => {
		expect(() => manager.setSessionFavorite("sess-fav", true)).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-fav");
	});

	it("setSessionTitle invokes the sync writable gate", () => {
		expect(() => manager.setSessionTitle("sess-title", "x")).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-title");
	});

	it("setSessionTags invokes the sync writable gate", () => {
		expect(() => manager.setSessionTags("sess-tags", ["a"])).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-tags");
	});

	it("setSessionAppServerGoal invokes the sync writable gate", () => {
		expect(() => manager.setSessionAppServerGoal("sess-goal", null)).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-goal");
	});

	it("saveSessionSummary invokes the sync writable gate", () => {
		expect(() =>
			manager.saveSessionSummary("summary text", "sess-sum"),
		).toThrow(SessionAccessDeniedError);
		expect(stub.writes).toContain("sess-sum");
	});

	it("saveSessionResumeSummary invokes the sync writable gate", () => {
		expect(() =>
			manager.saveSessionResumeSummary("resume text", "sess-resume"),
		).toThrow(SessionAccessDeniedError);
		expect(stub.writes).toContain("sess-resume");
	});

	it("saveSessionMemoryExtractionHash invokes the sync writable gate", () => {
		expect(() =>
			manager.saveSessionMemoryExtractionHash("deadbeef", "sess-hash"),
		).toThrow(SessionAccessDeniedError);
		expect(stub.writes).toContain("sess-hash");
	});

	it("setSessionFile invokes the sync writable gate (closes the active-session redirect)", () => {
		// The bug: an in-process caller could flip the manager's bound
		// sessionId to an arbitrary target via setSessionFile and then
		// have subsequent writes land on that target. The gate now
		// fires synchronously before the assignment.
		expect(() => manager.setSessionFile("db:sess-flip")).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain("sess-flip");
		// And the manager's sessionId did NOT change.
		expect(manager.getSessionId()).not.toBe("sess-flip");
	});

	it("saveAttachmentExtraction always gates — no same-session bypass (round-2-review fix)", () => {
		// Round-2-review fix: the previous same-session bypass was
		// TOCTOU-vulnerable through setSessionFile (an in-process
		// caller could flip this.sessionId to a target, have ownership
		// revoked, and keep writing because the same-session check
		// passed). Now every call goes through the gate.
		const ownId = manager.getSessionId();
		expect(() =>
			manager.saveAttachmentExtraction(ownId, "att-1", "text"),
		).toThrow(SessionAccessDeniedError);
		expect(stub.writes).toContain(ownId);
	});

	it("saveAttachmentExtraction with empty sessionRef no longer routes to bound session (round-2-review fix)", () => {
		// Round-2-review fix: previously `targetSessionId &&` short-
		// circuited on empty string, silently routing the write to
		// whatever session the manager was bound to. Now empty
		// normalizes through resolveSessionId → bound session, and
		// the gate fires uniformly.
		const ownId = manager.getSessionId();
		expect(() => manager.saveAttachmentExtraction("", "att-x", "text")).toThrow(
			SessionAccessDeniedError,
		);
		expect(stub.writes).toContain(ownId);
	});

	// Round-2-review fix: deleteSession now triggers
	// `onSessionDestroyed` hook so the daemon's owner map sheds the
	// entry rather than growing unbounded / leaving ghost ownership.
	it("deleteSession invokes the onSessionDestroyed hook", async () => {
		const sessionId = "11111111-1111-4111-a111-111111111111";
		const destroyed: string[] = [];
		const localStub = new (class extends DenyingAccessControl {
			override async assertSessionWritable(): Promise<void> {
				// Pass the gate so we reach the DB call.
			}
		})();
		setSessionAccessControl(localStub);
		const m = new HostedSessionManager({
			scope: "test",
			hooks: { onSessionDestroyed: (id) => destroyed.push(id) },
		});
		await expect(m.deleteSession(sessionId)).resolves.toBeUndefined();
		expect(destroyed).toEqual([sessionId]);
	});

	it("createSession invokes the onSessionCreated hook before the DB call", async () => {
		// Adversarial-review round-2 fix: `onSessionCreated` fires
		// BEFORE `ensureSessionRow` so the owner is seeded before
		// any downstream write gate-check runs. Even if the DB call
		// fails, the owner record is already set.
		const created: { id: string }[] = [];
		const m = new HostedSessionManager({
			scope: "test",
			hooks: {
				onSessionCreated: (id) => created.push({ id }),
			},
		});
		// createSession will fail on the DB call but the hook fires first
		await m.createSession({}).catch(() => {});
		expect(created).toHaveLength(1);
		expect(created[0].id).toBe(m.getSessionId());
	});

	it("createBranchedSessionFromState invokes the onSessionCreated hook for the branch", async () => {
		const created: { id: string }[] = [];
		const m = new HostedSessionManager({
			scope: "test",
			hooks: {
				onSessionCreated: (id) => created.push({ id }),
			},
		});
		const originalSessionId = m.getSessionId();
		// createBranchedSessionFromState will also fail on DB but hook fires first
		await m
			.createBranchedSessionFromState(
				{
					model: { provider: "test", id: "gpt-4" },
					messages: [],
				} as never,
				0,
			)
			.catch(() => {});
		expect(created).toHaveLength(1);
		// The branch gets a new session ID, different from the original
		expect(created[0].id).not.toBe(originalSessionId);
	});
});
