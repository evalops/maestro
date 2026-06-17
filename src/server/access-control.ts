/**
 * Session access control (#2641 scaffolding).
 *
 * Provides the per-request authorization boundary that state-manager
 * methods consult before touching a session. Today's CLI process is
 * single-user, so the default implementation
 * (`SingleUserSessionAccessControl`) is a no-op — every call passes,
 * matching today's behavior. The shape of the interface is the part
 * that's load-bearing: when the daemon work in #2609 lands, the
 * implementation gets swapped to `MultiClientSessionAccessControl`
 * (planned), and every call site that takes a `RequestContext`
 * automatically inherits the gate without further refactoring.
 *
 * The interface deliberately stays narrow:
 *
 *   - `assertSessionReadable(sessionId, ctx)` — throws if `ctx` may
 *     not read this session.
 *   - `assertSessionWritable(sessionId, ctx)` — throws if `ctx` may
 *     not mutate this session.
 *
 * Both methods throw the SAME error class (`SessionAccessDeniedError`)
 * regardless of whether the session doesn't exist or the caller lacks
 * permission, so the manager can't leak session existence to an
 * unauthenticated probe.
 *
 * See `docs/security/session-access-control.md` (TBD) for the
 * threat-model write-up.
 */

/**
 * Identity envelope every state-manager call carries. The daemon
 * (#2609) populates this from the transport layer (Unix socket peer
 * creds, HTTP `Authorization`, WebSocket auth handshake). Today the
 * envelope is filled with `SINGLE_USER_CONTEXT` everywhere.
 */
export interface RequestContext {
	/** Stable identifier for the client process making the call. */
	clientId: string;
	/** Optional user identifier — set in multi-user contexts (#2609). */
	userId?: string;
	/** Opaque bearer token when the transport requires it. */
	authToken?: string;
	/** Optional trace correlation id for observability. */
	traceparent?: string;
}

/**
 * Constant context used in single-user mode. Every caller can use this
 * today; the daemon will replace it with per-transport contexts later.
 */
export const SINGLE_USER_CONTEXT: RequestContext = {
	clientId: "single-user-process",
};

export interface SessionAccessControl {
	/**
	 * Throw `SessionAccessDeniedError` if `ctx` may not read
	 * `sessionId`. Implementations must use the same error shape for
	 * "session does not exist" and "session belongs to another caller"
	 * so existence is not leaked.
	 */
	assertSessionReadable(sessionId: string, ctx: RequestContext): Promise<void>;

	/** Throw if `ctx` may not write `sessionId`. Same constraint. */
	assertSessionWritable(sessionId: string, ctx: RequestContext): Promise<void>;

	/**
	 * Synchronous variant of `assertSessionReadable` for call sites
	 * that cannot await (e.g. fire-and-forget setters that enqueue a
	 * DB write). Today's implementations all do synchronous in-memory
	 * checks, so the sync form is always safe. The async form remains
	 * the canonical API; new code should prefer it.
	 */
	assertSessionReadableSync(sessionId: string, ctx: RequestContext): void;

	/** Synchronous variant of `assertSessionWritable`. Same caveat. */
	assertSessionWritableSync(sessionId: string, ctx: RequestContext): void;
}

export class SessionAccessDeniedError extends Error {
	constructor(sessionId: string, reason: string) {
		super(`Access to session ${sessionId} denied: ${reason}`);
		this.name = "SessionAccessDeniedError";
	}
}

/**
 * Single-user default. Every call passes. The point of having an
 * explicit implementation is that today's call sites can already
 * thread `RequestContext` through and call
 * `accessControl.assertSessionReadable(...)` — the gate is wired even
 * though it doesn't deny anything yet. When the daemon ships, the
 * binding is swapped to `MultiClientSessionAccessControl` and the
 * existing call sites pick up the real gate without further
 * refactoring.
 */
export class SingleUserSessionAccessControl implements SessionAccessControl {
	async assertSessionReadable(
		_sessionId: string,
		_ctx: RequestContext,
	): Promise<void> {
		// Single-user mode: every session is owned by the only user.
	}

	async assertSessionWritable(
		_sessionId: string,
		_ctx: RequestContext,
	): Promise<void> {
		// Single-user mode: every session is owned by the only user.
	}

	assertSessionReadableSync(_sessionId: string, _ctx: RequestContext): void {
		// Single-user mode: noop.
	}

	assertSessionWritableSync(_sessionId: string, _ctx: RequestContext): void {
		// Single-user mode: noop.
	}
}

/**
 * UUID-shape check used to refuse session ids that don't look like
 * the `randomUUID()` output the session manager actually issues.
 * Rejects path-traversal, log-injection, prototype-pollution-style,
 * and unbounded-length inputs at the gate (#2641 adversarial review).
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidSessionId(sessionId: string): boolean {
	return UUID_PATTERN.test(sessionId);
}

/**
 * Admin handle for `MultiClientSessionAccessControl`. Returned only
 * by `createMultiClientSessionAccessControl()` to whichever code
 * constructs the gate — the daemon at startup. The gate that goes
 * into `setSessionAccessControl()` does NOT expose these methods, so
 * arbitrary in-process code (a malicious plugin, an MCP server, an
 * untrusted skill) cannot recover the admin handle via
 * `getSessionAccessControl()`. (Adversarial-review fix.)
 */
export interface SessionAccessControlAdmin {
	/**
	 * Seed (or replace) the owner of `sessionId`. The daemon calls this
	 * at session-creation time so the first read/write check has an
	 * owner to compare against, and for admin-initiated takeover.
	 */
	recordSessionOwner(sessionId: string, clientId: string): void;
	/** Forget the owner. Used when a session is destroyed. */
	forgetSessionOwner(sessionId: string): void;
	/** Diagnostics: how many sessions have owners? */
	ownedSessionCount(): number;
}

/**
 * Factory for the multi-client gate. Returns the gate (narrow
 * `SessionAccessControl` interface, suitable for
 * `setSessionAccessControl`) and a separate admin handle. Only the
 * caller of the factory retains the admin handle; nothing reachable
 * via `getSessionAccessControl()` can mutate the owner map.
 *
 * Ownership MUST be seeded by the daemon (via
 * `admin.recordSessionOwner`) at session-creation time — an
 * `assertSession*` call against an un-owned session is refused.
 * Refusals use the same error reason string regardless of cause so
 * the error message does not distinguish "no such session" from
 * "wrong owner" (no existence oracle).
 */
export function createMultiClientSessionAccessControl(): {
	gate: SessionAccessControl;
	admin: SessionAccessControlAdmin;
} {
	const owners = new Map<string, string>();

	const refuse = (sessionId: string): never => {
		throw new SessionAccessDeniedError(sessionId, "denied");
	};

	const assertOwner = (sessionId: string, ctx: RequestContext): void => {
		if (!isValidSessionId(sessionId)) refuse(sessionId);
		const owner = owners.get(sessionId);
		if (owner === undefined) refuse(sessionId);
		if (owner !== ctx.clientId) refuse(sessionId);
	};

	const gate: SessionAccessControl = {
		async assertSessionReadable(
			sessionId: string,
			ctx: RequestContext,
		): Promise<void> {
			assertOwner(sessionId, ctx);
		},
		async assertSessionWritable(
			sessionId: string,
			ctx: RequestContext,
		): Promise<void> {
			assertOwner(sessionId, ctx);
		},
		assertSessionReadableSync(sessionId: string, ctx: RequestContext): void {
			assertOwner(sessionId, ctx);
		},
		assertSessionWritableSync(sessionId: string, ctx: RequestContext): void {
			assertOwner(sessionId, ctx);
		},
	};

	const admin: SessionAccessControlAdmin = {
		recordSessionOwner(sessionId: string, clientId: string): void {
			if (!isValidSessionId(sessionId)) refuse(sessionId);
			owners.set(sessionId, clientId);
		},
		forgetSessionOwner(sessionId: string): void {
			owners.delete(sessionId);
		},
		ownedSessionCount(): number {
			return owners.size;
		},
	};

	return { gate, admin };
}

/**
 * Backwards-compatible class form retained for callers that already
 * import `MultiClientSessionAccessControl` directly (tests, the
 * scaffolding from #2731).
 *
 * **The admin handle is exposed on this class as a single property,
 * not as direct methods.** A caller that obtains the gate via
 * `getSessionAccessControl()` gets the narrow
 * `SessionAccessControl` interface (no admin reachable). A caller
 * that constructs an instance with `new
 * MultiClientSessionAccessControl()` gets the admin handle on
 * `.admin` — exactly the same exposure as
 * `createMultiClientSessionAccessControl()`. The previous shape
 * (round-2-review finding: direct `recordSessionOwner` /
 * `forgetSessionOwner` methods on the class) is removed so a
 * `getSessionAccessControl() as any` cast cannot recover the admin
 * handle.
 *
 * @deprecated use `createMultiClientSessionAccessControl()` instead.
 */
export class MultiClientSessionAccessControl implements SessionAccessControl {
	private readonly inner = createMultiClientSessionAccessControl();
	/** Admin handle (owner-map mutators). Hold a reference to this
	 * directly from construction; do not attempt to recover it via
	 * `getSessionAccessControl()`. */
	readonly admin: SessionAccessControlAdmin = this.inner.admin;
	assertSessionReadable(sessionId: string, ctx: RequestContext): Promise<void> {
		return this.inner.gate.assertSessionReadable(sessionId, ctx);
	}
	assertSessionWritable(sessionId: string, ctx: RequestContext): Promise<void> {
		return this.inner.gate.assertSessionWritable(sessionId, ctx);
	}
	assertSessionReadableSync(sessionId: string, ctx: RequestContext): void {
		this.inner.gate.assertSessionReadableSync(sessionId, ctx);
	}
	assertSessionWritableSync(sessionId: string, ctx: RequestContext): void {
		this.inner.gate.assertSessionWritableSync(sessionId, ctx);
	}
}

/**
 * Default binding. Replace at daemon startup (#2609) by calling
 * `setSessionAccessControl(createMultiClientSessionAccessControl().gate)`
 * and retaining the admin handle for owner seeding.
 */
let activeAccessControl: SessionAccessControl =
	new SingleUserSessionAccessControl();

/**
 * Tamper-evident lock. Once the daemon has bound its real
 * implementation and called `lockSessionAccessControl()`, further
 * `setSessionAccessControl` calls throw. Defense in depth against a
 * compromised plugin/library swapping the gate back to a permissive
 * impl after startup.
 */
let bindingLocked = false;

export function getSessionAccessControl(): SessionAccessControl {
	return activeAccessControl;
}

export function setSessionAccessControl(impl: SessionAccessControl): void {
	if (bindingLocked) {
		throw new Error(
			"SessionAccessControl binding is locked; cannot replace after lockSessionAccessControl()",
		);
	}
	activeAccessControl = impl;
}

/**
 * Freeze the current binding. After this call, `setSessionAccessControl`
 * throws. Intended to be called exactly once, immediately after the
 * daemon binds its real implementation at startup. Idempotent.
 */
export function lockSessionAccessControl(): void {
	bindingLocked = true;
}

/** Whether the binding has been locked. Exposed for diagnostics. */
export function isSessionAccessControlLocked(): boolean {
	return bindingLocked;
}

/** Test helper — restore the default binding and unlock. */
export function resetSessionAccessControlForTests(): void {
	bindingLocked = false;
	activeAccessControl = new SingleUserSessionAccessControl();
}
