/**
 * Daemon IPC session lifecycle state machine
 *
 * Builds on the IPC envelope (part 1 of #2658, merged as #2683) and
 * the capability negotiator (part 4 of #2658, #2706). Pure state
 * machine that tracks where an IPC session is in its lifecycle so the
 * dispatcher can reject misordered messages (a `request` before
 * `hello`, an `event` subscription after the client started closing,
 * etc) without each handler re-deriving the rule.
 *
 * State diagram:
 *
 *   connected → handshaking → ready → draining → closed
 *        ↓           ↓          ↓        ↓
 *        └───────────└──────────└────────┴───────→ failed
 *
 *   - connected:   socket accepted, no hello received yet
 *   - handshaking: client sent hello, daemon hasn't replied yet
 *   - ready:       welcome sent; normal request/response/event traffic
 *   - draining:    one side asked to close; in-flight requests allowed
 *                  to finish, no new requests accepted
 *   - closed:      socket released; terminal
 *   - failed:      unrecoverable error (protocol violation, transport
 *                  fault); terminal
 *
 * What this module is NOT: the transport, the actual handshake
 * negotiation, the dispatcher. Those layers consume this primitive.
 *
 * Pure data + functions. No I/O.
 */

/** Discrete states the session can be in. */
export type IpcSessionState =
	| "connected"
	| "handshaking"
	| "ready"
	| "draining"
	| "closed"
	| "failed";

/** What kind of message the dispatcher is about to handle. */
export type IpcMessageKind = "hello" | "request" | "response" | "event";

/** Verdict for "can I send/accept this kind of message right now?". */
export type IpcSessionTransitionResult =
	| { ok: true; nextState: IpcSessionState }
	| { ok: false; reason: IpcSessionTransitionReason };

export type IpcSessionTransitionReason =
	| "hello-before-connect"
	| "hello-already-received"
	| "request-before-ready"
	| "request-during-drain"
	| "response-before-ready"
	| "event-before-ready"
	| "event-after-drain"
	| "already-closed"
	| "already-failed";

/**
 * Compute the next state after handling `kind` while in `current`.
 * Returns the new state on success or a structured failure the
 * caller can translate into an `IpcErrorResponse`. Pure function.
 */
export function transitionForMessage(
	current: IpcSessionState,
	kind: IpcMessageKind,
): IpcSessionTransitionResult {
	if (current === "closed") {
		return { ok: false, reason: "already-closed" };
	}
	if (current === "failed") {
		return { ok: false, reason: "already-failed" };
	}

	switch (kind) {
		case "hello":
			if (current === "connected") {
				return { ok: true, nextState: "handshaking" };
			}
			return { ok: false, reason: "hello-already-received" };
		case "request":
			if (current === "ready") {
				return { ok: true, nextState: "ready" };
			}
			if (current === "draining") {
				return { ok: false, reason: "request-during-drain" };
			}
			return { ok: false, reason: "request-before-ready" };
		case "response":
			if (current === "ready" || current === "draining") {
				return { ok: true, nextState: current };
			}
			return { ok: false, reason: "response-before-ready" };
		case "event":
			if (current === "ready") {
				return { ok: true, nextState: "ready" };
			}
			if (current === "draining") {
				return { ok: false, reason: "event-after-drain" };
			}
			return { ok: false, reason: "event-before-ready" };
	}
}

/**
 * Move from `handshaking` to `ready` once the daemon has finished
 * negotiating capabilities and sent the welcome. Throws if called
 * from any other state — that would mean the dispatcher tried to
 * "complete handshake" without an outstanding hello.
 */
export function completeHandshake(current: IpcSessionState): IpcSessionState {
	if (current !== "handshaking") {
		throw new Error(
			`IPC session: cannot complete handshake from state "${current}" (expected "handshaking")`,
		);
	}
	return "ready";
}

/**
 * Begin a graceful shutdown. From `ready` or `handshaking` we enter
 * `draining` so in-flight requests can finish; from any other live
 * state we go straight to `closed`. Already-terminal states stay
 * where they are.
 */
export function beginShutdown(current: IpcSessionState): IpcSessionState {
	if (current === "closed" || current === "failed") return current;
	if (current === "ready" || current === "handshaking") return "draining";
	return "closed";
}

/**
 * Finalize the shutdown: from `draining` move to `closed`. From any
 * other non-terminal state, fall through to `closed` too — the
 * caller has decided the session is done. Terminal states stay.
 */
export function finishShutdown(current: IpcSessionState): IpcSessionState {
	if (current === "closed" || current === "failed") return current;
	return "closed";
}

/**
 * Trip into the terminal `failed` state. Used when the dispatcher
 * sees a protocol violation, the transport reports a fault, or any
 * other unrecoverable error. Terminal states stay where they are.
 */
export function markFailed(current: IpcSessionState): IpcSessionState {
	if (current === "closed" || current === "failed") return current;
	return "failed";
}

/** True when the session is in a state that can still send/receive. */
export function isLive(state: IpcSessionState): boolean {
	return state !== "closed" && state !== "failed";
}

/** True when the session has reached a terminal state. */
export function isTerminal(state: IpcSessionState): boolean {
	return state === "closed" || state === "failed";
}
