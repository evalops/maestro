/**
 * IPC request/response correlator
 *
 * Builds on the IPC envelope (part 1 of #2658, merged as #2683).
 * Clients of the daemon IPC dispatch requests and need their replies
 * to land on the right Promise. This module owns that bookkeeping —
 * pure in-memory map of `request.id` → pending promise. Receive a
 * response message, resolve the matching promise. Receive an
 * unsolicited event, hand it to the event subscribers.
 *
 * What's NOT here: socket transport, framing (that's the envelope's
 * job already), retry logic. The transport calls `send` on a
 * `RequestCorrelator` for every outbound request, then feeds every
 * inbound message into `receive`.
 *
 * Design notes:
 *   - Request ids are allocated by the correlator (caller doesn't
 *     need to manage them) but can be overridden for tests.
 *   - Timeouts are per-request and trigger `reject` with a typed
 *     `IpcRequestTimeoutError`.
 *   - On `dispose()` every pending request rejects with
 *     `IpcCorrelatorDisposedError` so callers never see a hung
 *     promise after the transport closes.
 */

import {
	type IpcEvent,
	type IpcMessage,
	type IpcRequest,
	type IpcResponse,
	makeRequest,
} from "./ipc-envelope.js";

/** Function the correlator calls to actually transmit a request. */
export type SendFn = (request: IpcRequest) => void;

/** Callback for unsolicited events. */
export type EventListener<TPayload = unknown> = (
	event: IpcEvent<TPayload>,
) => void;

/** Error a pending request rejects with when its timeout elapses. */
export class IpcRequestTimeoutError extends Error {
	constructor(
		public readonly id: string,
		public readonly method: string,
		public readonly timeoutMs: number,
	) {
		super(
			`IPC request "${method}" (id "${id}") timed out after ${timeoutMs}ms`,
		);
		this.name = "IpcRequestTimeoutError";
	}
}

/** Error pending requests reject with when the correlator is disposed. */
export class IpcCorrelatorDisposedError extends Error {
	constructor() {
		super("IPC correlator was disposed before this request received a reply");
		this.name = "IpcCorrelatorDisposedError";
	}
}

/** Error error responses reject with. */
export class IpcResponseError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(`IPC error response "${code}": ${message}`);
		this.name = "IpcResponseError";
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	method: string;
	timer?: ReturnType<typeof setTimeout>;
}

export interface CorrelatorOptions {
	/** Function the correlator calls to send each request. */
	send: SendFn;
	/**
	 * Optional id generator. Defaults to a monotonic counter
	 * (`req-1`, `req-2`, …). Override for tests that need
	 * deterministic ids.
	 */
	allocateId?: () => string;
	/**
	 * Default timeout for `request()` calls that don't pass an explicit
	 * `timeoutMs`. `0` or negative disables the default. Defaults to
	 * 30_000 (30s).
	 */
	defaultTimeoutMs?: number;
}

export interface RequestOptions {
	/**
	 * Per-call timeout in ms. Overrides `defaultTimeoutMs`. `0` or
	 * negative disables the timeout for this call.
	 */
	timeoutMs?: number;
}

/**
 * Stateful correlator: built around a `send` function and an inbound
 * `receive` pump. Most callers wrap this once at daemon-client
 * construction and forward incoming socket frames into
 * `receive(message)`.
 */
export class RequestCorrelator {
	private readonly send: SendFn;
	private readonly allocateId: () => string;
	private readonly defaultTimeoutMs: number;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<EventListener>();
	private nextSeq = 1;
	private disposed = false;

	constructor(options: CorrelatorOptions) {
		this.send = options.send;
		this.allocateId = options.allocateId ?? (() => `req-${this.nextSeq++}`);
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
	}

	/**
	 * Dispatch a request and return a promise for its response. The
	 * promise resolves with the `result` field on success or rejects
	 * with `IpcResponseError` on an error response. Times out per
	 * `timeoutMs` (or `defaultTimeoutMs` on construction).
	 */
	request<TParams = unknown, TResult = unknown>(
		method: string,
		params?: TParams,
		options: RequestOptions = {},
	): Promise<TResult> {
		if (this.disposed) {
			return Promise.reject(new IpcCorrelatorDisposedError());
		}
		const id = this.allocateId();
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
		const request = makeRequest<TParams>(id, method, params);
		return new Promise<TResult>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve: resolve as (v: unknown) => void,
				reject,
				method,
			};
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new IpcRequestTimeoutError(id, method, timeoutMs));
				}, timeoutMs);
			}
			this.pending.set(id, pending);
			try {
				this.send(request);
			} catch (err) {
				// Synchronously failed to put the request on the wire —
				// clean up and surface the error to the caller.
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Hand an inbound message to the correlator. Responses resolve or
	 * reject the matching pending request; events fan out to every
	 * subscriber. Unknown ids (late responses, replays) are silently
	 * dropped.
	 */
	receive(message: IpcMessage): void {
		if (message.kind === "response") {
			this.receiveResponse(message);
			return;
		}
		if (message.kind === "event") {
			this.receiveEvent(message);
			return;
		}
		// Inbound requests aren't this correlator's job — the daemon
		// side handles them. Silently drop here.
	}

	/** Subscribe to unsolicited events. Returns an unsubscribe function. */
	onEvent<TPayload = unknown>(listener: EventListener<TPayload>): () => void {
		this.eventListeners.add(listener as EventListener);
		return () => {
			this.eventListeners.delete(listener as EventListener);
		};
	}

	/** Number of requests still awaiting a response. */
	pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Reject every pending request and stop accepting new ones. Safe
	 * to call repeatedly. Callers wire this into transport close so a
	 * dropped socket never leaves a promise hung.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new IpcCorrelatorDisposedError());
		}
		this.pending.clear();
		this.eventListeners.clear();
	}

	private receiveResponse(response: IpcResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (response.ok) {
			pending.resolve(response.result);
		} else {
			pending.reject(
				new IpcResponseError(
					response.error.code,
					response.error.message,
					response.error.details,
				),
			);
		}
	}

	private receiveEvent(event: IpcEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (err) {
				// Defensive: one rude listener shouldn't kill the rest.
				// Surface to the host via console rather than crash the
				// receive pump.
				console.error("IPC event listener threw", err);
			}
		}
	}
}
