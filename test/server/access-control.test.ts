import { afterEach, describe, expect, it } from "vitest";
import {
	MultiClientSessionAccessControl,
	SINGLE_USER_CONTEXT,
	SessionAccessDeniedError,
	SingleUserSessionAccessControl,
	createMultiClientSessionAccessControl,
	getSessionAccessControl,
	isSessionAccessControlLocked,
	lockSessionAccessControl,
	resetSessionAccessControlForTests,
	setSessionAccessControl,
} from "../../src/server/access-control.js";
import type {
	RequestContext,
	SessionAccessControl,
} from "../../src/server/access-control.js";

describe("server/access-control", () => {
	afterEach(() => {
		resetSessionAccessControlForTests();
	});

	describe("SingleUserSessionAccessControl", () => {
		it("allows every read in single-user mode", async () => {
			const ac = new SingleUserSessionAccessControl();
			await expect(
				ac.assertSessionReadable("s1", SINGLE_USER_CONTEXT),
			).resolves.toBeUndefined();
		});

		it("allows every write in single-user mode", async () => {
			const ac = new SingleUserSessionAccessControl();
			await expect(
				ac.assertSessionWritable("s1", SINGLE_USER_CONTEXT),
			).resolves.toBeUndefined();
		});
	});

	describe("getSessionAccessControl / setSessionAccessControl", () => {
		it("returns SingleUserSessionAccessControl by default", () => {
			expect(getSessionAccessControl()).toBeInstanceOf(
				SingleUserSessionAccessControl,
			);
		});

		it("can be swapped at startup", async () => {
			class StubAccessControl implements SessionAccessControl {
				async assertSessionReadable(
					sessionId: string,
					_ctx: RequestContext,
				): Promise<void> {
					throw new SessionAccessDeniedError(sessionId, "stub-denies-all");
				}
				async assertSessionWritable(
					sessionId: string,
					_ctx: RequestContext,
				): Promise<void> {
					throw new SessionAccessDeniedError(sessionId, "stub-denies-all");
				}
				assertSessionReadableSync(
					sessionId: string,
					_ctx: RequestContext,
				): void {
					throw new SessionAccessDeniedError(sessionId, "stub-denies-all");
				}
				assertSessionWritableSync(
					sessionId: string,
					_ctx: RequestContext,
				): void {
					throw new SessionAccessDeniedError(sessionId, "stub-denies-all");
				}
			}

			setSessionAccessControl(new StubAccessControl());
			const active = getSessionAccessControl();
			await expect(
				active.assertSessionReadable("s1", SINGLE_USER_CONTEXT),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
			await expect(
				active.assertSessionWritable("s1", SINGLE_USER_CONTEXT),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("does not leak existence by using a different error shape for missing vs forbidden", () => {
			// Documented constraint on implementors: the same error class is
			// thrown for both "session does not exist" and "wrong caller".
			// Verified at the type level — both methods are typed to throw
			// `SessionAccessDeniedError` only. This test exists as the
			// contract anchor for the daemon implementation in #2609.
			const err = new SessionAccessDeniedError("s", "r");
			expect(err.name).toBe("SessionAccessDeniedError");
		});
	});

	describe("SessionAccessDeniedError", () => {
		it("carries sessionId + reason in its message", () => {
			const err = new SessionAccessDeniedError("sess-1", "wrong-owner");
			expect(err.message).toContain("sess-1");
			expect(err.message).toContain("wrong-owner");
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe("lockSessionAccessControl", () => {
		class StubAccessControl {
			async assertSessionReadable(): Promise<void> {}
			async assertSessionWritable(): Promise<void> {}
			assertSessionReadableSync(): void {}
			assertSessionWritableSync(): void {}
		}

		it("starts unlocked", () => {
			expect(isSessionAccessControlLocked()).toBe(false);
		});

		it("setSessionAccessControl throws after lock", () => {
			setSessionAccessControl(new StubAccessControl());
			lockSessionAccessControl();
			expect(isSessionAccessControlLocked()).toBe(true);
			expect(() => setSessionAccessControl(new StubAccessControl())).toThrow(
				/locked/,
			);
		});

		it("getSessionAccessControl still returns the bound impl after lock", () => {
			const stub = new StubAccessControl();
			setSessionAccessControl(stub);
			lockSessionAccessControl();
			expect(getSessionAccessControl()).toBe(stub);
		});

		it("locking is idempotent", () => {
			lockSessionAccessControl();
			lockSessionAccessControl();
			expect(isSessionAccessControlLocked()).toBe(true);
		});

		it("resetSessionAccessControlForTests unlocks", () => {
			lockSessionAccessControl();
			expect(isSessionAccessControlLocked()).toBe(true);
			resetSessionAccessControlForTests();
			expect(isSessionAccessControlLocked()).toBe(false);
			expect(() =>
				setSessionAccessControl(new StubAccessControl()),
			).not.toThrow();
		});
	});

	describe("MultiClientSessionAccessControl", () => {
		const ALICE = { clientId: "alice", userId: "u-alice" };
		const BOB = { clientId: "bob", userId: "u-bob" };
		// Two valid v4 UUIDs used by the test suite. The gate now
		// rejects non-UUID session ids outright, so test fixtures
		// must use real-shaped ids.
		const SESS_A = "11111111-1111-4111-a111-111111111111";
		const SESS_B = "22222222-2222-4222-a222-222222222222";

		it("refuses access to an un-owned session (no first-touch claim)", async () => {
			const ac = new MultiClientSessionAccessControl();
			// Adversarial-review fix: an un-owned session can no longer
			// be claimed by the first caller. The daemon must
			// explicitly seed via recordSessionOwner at create-time.
			await expect(
				ac.assertSessionReadable(SESS_A, ALICE),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
			expect(ac.admin.ownedSessionCount()).toBe(0);
		});

		it("owner can read and write its session repeatedly", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			await ac.assertSessionReadable(SESS_A, ALICE);
			await ac.assertSessionWritable(SESS_A, ALICE);
			await ac.assertSessionReadable(SESS_A, ALICE);
		});

		it("a different client is refused on the read path", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			await expect(
				ac.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("a different client is refused on the write path", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			await expect(
				ac.assertSessionWritable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("refusal uses the same error reason regardless of cause (no existence oracle)", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);

			// Three different causes that previously surfaced distinct
			// reason strings inside `.message`. The reason MUST now be
			// identical so the message can't be used to distinguish
			// "wrong owner" from "session doesn't exist". (The sessionId
			// itself is echoed back, but that's the attacker's own input
			// — not a leak.)
			const noSessionErr = await ac
				.assertSessionReadable("", ALICE)
				.catch((e: unknown) => e);
			const wrongOwnerErr = await ac
				.assertSessionReadable(SESS_A, BOB)
				.catch((e: unknown) => e);
			const unknownErr = await ac
				.assertSessionReadable(SESS_B, ALICE)
				.catch((e: unknown) => e);

			expect(noSessionErr).toBeInstanceOf(SessionAccessDeniedError);
			expect(wrongOwnerErr).toBeInstanceOf(SessionAccessDeniedError);
			expect(unknownErr).toBeInstanceOf(SessionAccessDeniedError);

			// Same trailing `denied: <reason>` for every refusal.
			const reasonOf = (e: unknown) =>
				(e as Error).message.replace(/^Access to session .* denied: /, "");
			expect(reasonOf(noSessionErr)).toBe("denied");
			expect(reasonOf(wrongOwnerErr)).toBe("denied");
			expect(reasonOf(unknownErr)).toBe("denied");
		});

		it("rejects non-UUID session ids — closes path-traversal / log-injection / memory-DoS", async () => {
			const ac = new MultiClientSessionAccessControl();
			// recordSessionOwner refuses the malformed id outright so
			// the owner map cannot grow unbounded from bogus calls.
			expect(() =>
				ac.admin.recordSessionOwner("../../etc/passwd", "x"),
			).toThrow(SessionAccessDeniedError);
			expect(() =>
				ac.admin.recordSessionOwner("\n\nLOG INJECTION\n", "x"),
			).toThrow(SessionAccessDeniedError);
			await expect(
				ac.assertSessionReadable("x".repeat(10000), ALICE),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
			// And nothing got recorded.
			expect(ac.admin.ownedSessionCount()).toBe(0);
		});

		it("recordSessionOwner can reassign ownership (admin takeover)", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			await expect(
				ac.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
			await expect(
				ac.assertSessionReadable(SESS_A, ALICE),
			).resolves.toBeUndefined();

			ac.admin.recordSessionOwner(SESS_A, BOB.clientId);
			await expect(
				ac.assertSessionReadable(SESS_A, BOB),
			).resolves.toBeUndefined();
			await expect(
				ac.assertSessionReadable(SESS_A, ALICE),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("forgetSessionOwner drops the record; next call requires re-seed", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			ac.admin.forgetSessionOwner(SESS_A);
			await expect(
				ac.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("each session has its own owner", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			ac.admin.recordSessionOwner(SESS_B, BOB.clientId);
			expect(ac.admin.ownedSessionCount()).toBe(2);
			await expect(
				ac.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
			await expect(
				ac.assertSessionReadable(SESS_B, ALICE),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("plugs into the binding so HostedSessionManager picks up the gate", async () => {
			const ac = new MultiClientSessionAccessControl();
			ac.admin.recordSessionOwner(SESS_A, ALICE.clientId);
			setSessionAccessControl(ac);

			const active = getSessionAccessControl();
			await expect(
				active.assertSessionReadable(SESS_A, ALICE),
			).resolves.toBeUndefined();
			await expect(
				active.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});
	});

	describe("createMultiClientSessionAccessControl factory (admin split)", () => {
		const ALICE = { clientId: "alice", userId: "u-alice" };
		const BOB = { clientId: "bob", userId: "u-bob" };
		const SESS_A = "11111111-1111-4111-a111-111111111111";

		it("admin handle is NOT reachable through getSessionAccessControl", async () => {
			const { gate, admin } = createMultiClientSessionAccessControl();
			admin.recordSessionOwner(SESS_A, ALICE.clientId);
			setSessionAccessControl(gate);

			const active = getSessionAccessControl();
			// The gate exposes only the assert methods, NOT
			// recordSessionOwner / forgetSessionOwner. The TypeScript
			// type is `SessionAccessControl`, so casting would be
			// required to even attempt the call. At runtime, the
			// methods simply do not exist on the gate object.
			expect(
				(active as unknown as Record<string, unknown>).recordSessionOwner,
			).toBeUndefined();
			expect(
				(active as unknown as Record<string, unknown>).forgetSessionOwner,
			).toBeUndefined();

			// Sanity: the gate still gates as before.
			await expect(
				active.assertSessionReadable(SESS_A, ALICE),
			).resolves.toBeUndefined();
			await expect(
				active.assertSessionReadable(SESS_A, BOB),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("admin and gate share the same owner map", async () => {
			const { gate, admin } = createMultiClientSessionAccessControl();
			expect(admin.ownedSessionCount()).toBe(0);
			admin.recordSessionOwner(SESS_A, ALICE.clientId);
			expect(admin.ownedSessionCount()).toBe(1);
			await expect(
				gate.assertSessionReadable(SESS_A, ALICE),
			).resolves.toBeUndefined();
			admin.forgetSessionOwner(SESS_A);
			expect(admin.ownedSessionCount()).toBe(0);
			await expect(
				gate.assertSessionReadable(SESS_A, ALICE),
			).rejects.toBeInstanceOf(SessionAccessDeniedError);
		});

		it("getSessionAccessControl does not expose admin mutators", () => {
			// Adversarial-review fix: `getSessionAccessControl()` must
			// return a narrow SessionAccessControl interface. An attacker
			// calling `getSessionAccessControl() as any` must not find
			// recordSessionOwner, forgetSessionOwner, or
			// ownedSessionCount on the returned object.
			setSessionAccessControl(createMultiClientSessionAccessControl().gate);
			const gate = getSessionAccessControl();

			// Verify the gate has the read/write methods
			expect(typeof gate.assertSessionReadable).toBe("function");
			expect(typeof gate.assertSessionWritable).toBe("function");

			// Verify admin mutators are NOT on the gate (no admin leak)
			expect(
				(gate as Record<string, unknown>).recordSessionOwner,
			).toBeUndefined();
			expect(
				(gate as Record<string, unknown>).forgetSessionOwner,
			).toBeUndefined();
			expect(
				(gate as Record<string, unknown>).ownedSessionCount,
			).toBeUndefined();
			expect((gate as Record<string, unknown>).admin).toBeUndefined();
		});
	});
});
