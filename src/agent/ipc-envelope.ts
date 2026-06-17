/**
 * Daemon IPC envelope
 *
 * Wire format for messages between the long-lived daemon process
 * (`daemon-core`) and per-client processes (`daemon-client`): TUI, IDE
 * extensions, web, Slack bridge. One process owns the agent loop and
 * scheduler; the rest are read/write views over the same session state
 * through this envelope.
 *
 * Wire shape (discriminated union on `kind`):
 *   - `request`  — client → daemon RPC. Has `id`, `method`, optional `params`.
 *   - `response` — daemon → client reply to a `request`. Carries the
 *     same `id` and either `result` or `error`.
 *   - `event`    — daemon → client unsolicited push (state changes,
 *     mission updates, log lines). No `id`; clients subscribe by
 *     `channel`.
 *
 * Capability negotiation:
 *   - First message in a session is a `request` with `method: "hello"`
 *     carrying the client's `protocolVersion` + advertised channels.
 *   - Daemon replies with a `welcome` result naming the agreed protocol
 *     version + the set of supported methods/channels.
 *   - Either side may close the connection if negotiation fails.
 *
 * Framing helpers (length-prefixed JSON):
 *   - `encodeFrame(message)` → Uint8Array suitable for socket write.
 *   - `decodeFrames(buffer)` → { frames, remainder } for stream parsing.
 *
 * What's NOT here: socket / pipe transport, daemon process lifecycle,
 * MultiSessionStateManager, method handler registry. This module is
 * the wire shape and nothing else.
 */

/** Schema version for the envelope itself (bumped on breaking changes). */
export const IPC_ENVELOPE_VERSION = 1;

/** Latest agent protocol version this build implements. */
export const IPC_PROTOCOL_VERSION = 1;

/** Discriminated union of all messages flowing across the socket. */
export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;

/** Client → daemon RPC request. */
export interface IpcRequest<TParams = unknown> {
	kind: "request";
	/** Envelope version. */
	v: number;
	/** Client-allocated unique id; the response echoes it back. */
	id: string;
	/** RPC method name, e.g. `"mission.list"`. */
	method: string;
	/** Method-specific parameters. May be absent. */
	params?: TParams;
}

/** Daemon → client reply for an `IpcRequest`. */
export type IpcResponse<TResult = unknown> =
	| IpcSuccessResponse<TResult>
	| IpcErrorResponse;

export interface IpcSuccessResponse<TResult = unknown> {
	kind: "response";
	v: number;
	/** The request id this response answers. */
	id: string;
	ok: true;
	result: TResult;
}

export interface IpcErrorResponse {
	kind: "response";
	v: number;
	id: string;
	ok: false;
	error: IpcError;
}

/** Daemon → client unsolicited push. */
export interface IpcEvent<TPayload = unknown> {
	kind: "event";
	v: number;
	/** Channel name (e.g. `"mission.updated"`, `"log"`). */
	channel: string;
	/** Event payload. */
	payload: TPayload;
}

/** Error payload carried inside an error response. */
export interface IpcError {
	/** Stable error code, e.g. `"unknown-method"`, `"bad-params"`. */
	code: string;
	/** Human-readable message. */
	message: string;
	/** Optional structured details. */
	details?: Record<string, unknown>;
}

/** Parameters for the `hello` capability handshake. */
export interface IpcHelloParams {
	/** Highest protocol version the client speaks. */
	protocolVersion: number;
	/** Client identifier, e.g. `"tui"`, `"vscode"`. */
	client: string;
	/** Channels the client wants to subscribe to. */
	channels?: string[];
}

/** Result of a successful `hello` handshake. */
export interface IpcWelcomeResult {
	/** Agreed protocol version (min of client + daemon). */
	protocolVersion: number;
	/** Daemon build identifier (semver + commit). */
	daemonBuild: string;
	/** Supported RPC method names. */
	methods: string[];
	/** Supported event channels. */
	channels: string[];
}

/** Factory: build an outgoing request. */
export function makeRequest<TParams>(
	id: string,
	method: string,
	params?: TParams,
): IpcRequest<TParams> {
	const req: IpcRequest<TParams> = {
		kind: "request",
		v: IPC_ENVELOPE_VERSION,
		id,
		method,
	};
	if (params !== undefined) {
		req.params = params;
	}
	return req;
}

/** Factory: build a success response. */
export function makeResponse<TResult>(
	id: string,
	result: TResult,
): IpcSuccessResponse<TResult> {
	return {
		kind: "response",
		v: IPC_ENVELOPE_VERSION,
		id,
		ok: true,
		result,
	};
}

/** Factory: build an error response. */
export function makeErrorResponse(
	id: string,
	error: IpcError,
): IpcErrorResponse {
	return {
		kind: "response",
		v: IPC_ENVELOPE_VERSION,
		id,
		ok: false,
		error,
	};
}

/** Factory: build an event push. */
export function makeEvent<TPayload>(
	channel: string,
	payload: TPayload,
): IpcEvent<TPayload> {
	return {
		kind: "event",
		v: IPC_ENVELOPE_VERSION,
		channel,
		payload,
	};
}

/**
 * Negotiate the protocol version for a `hello` handshake. The daemon
 * accepts any client whose claimed version is in
 * `[1, IPC_PROTOCOL_VERSION]`; older or newer clients are rejected.
 */
export function negotiateProtocolVersion(
	clientVersion: number,
	daemonVersion: number = IPC_PROTOCOL_VERSION,
): { ok: true; agreed: number } | { ok: false; reason: string } {
	if (!Number.isInteger(clientVersion) || clientVersion < 1) {
		return {
			ok: false,
			reason: "client protocol version must be a positive integer",
		};
	}
	if (clientVersion > daemonVersion) {
		return {
			ok: false,
			reason: `client protocol version ${clientVersion} exceeds daemon max ${daemonVersion}`,
		};
	}
	return { ok: true, agreed: clientVersion };
}

/**
 * True when `value` looks like a well-formed `IpcMessage`.
 *
 * Note on success responses and events: `JSON.stringify` drops keys
 * whose value is `undefined`, so a `makeResponse(id, undefined)` or
 * `makeEvent(channel, undefined)` round-trips back without the `result`
 * / `payload` key. We treat a missing key as equivalent to `undefined`
 * — otherwise the validator would reject messages the encoder happily
 * produced. Error responses still require a structured `error`.
 */
export function isIpcMessage(value: unknown): value is IpcMessage {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.v !== "number") return false;
	if (v.kind === "request") {
		return typeof v.id === "string" && typeof v.method === "string";
	}
	if (v.kind === "response") {
		if (typeof v.id !== "string") return false;
		if (v.ok === true) return true;
		if (v.ok === false) return isIpcError(v.error);
		return false;
	}
	if (v.kind === "event") {
		return typeof v.channel === "string";
	}
	return false;
}

function isIpcError(value: unknown): value is IpcError {
	if (typeof value !== "object" || value === null) return false;
	const e = value as Record<string, unknown>;
	return typeof e.code === "string" && typeof e.message === "string";
}

/**
 * Length-prefixed JSON framing. Each frame is:
 *   4-byte big-endian uint32 byte length
 *   N bytes of UTF-8 JSON
 *
 * Length prefix is the JSON byte length only, not including itself.
 * Throws if `message` serializes to more than 2^31-1 bytes.
 */
export function encodeFrame(message: IpcMessage): Uint8Array {
	const json = JSON.stringify(message);
	const body = new TextEncoder().encode(json);
	if (body.byteLength > 0x7fffffff) {
		throw new Error(
			`encodeFrame: message exceeds 2^31-1 bytes (${body.byteLength})`,
		);
	}
	const frame = new Uint8Array(4 + body.byteLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, body.byteLength, false);
	frame.set(body, 4);
	return frame;
}

/**
 * Stream parser: pull as many complete frames as `buffer` contains and
 * return the remainder (incomplete trailing frame) for the next call.
 *
 * Useful for reading from a unix socket / named pipe where the producer
 * may flush mid-message.
 */
export function decodeFrames(buffer: Uint8Array): {
	messages: IpcMessage[];
	remainder: Uint8Array;
} {
	const messages: IpcMessage[] = [];
	let offset = 0;
	while (offset + 4 <= buffer.byteLength) {
		const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
		const length = view.getUint32(0, false);
		// Reject lengths above the encoder's cap (2^31 - 1). A peer that
		// advertises 4 GB would otherwise force us to buffer up to that
		// much before we'd see the frame, which the encoder will never
		// produce — so the only callers are buggy or hostile.
		if (length > 0x7fffffff) {
			throw new Error(
				`decodeFrames: frame at offset ${offset} declares length ${length} > 2^31-1`,
			);
		}
		if (offset + 4 + length > buffer.byteLength) {
			break;
		}
		const body = buffer.subarray(offset + 4, offset + 4 + length);
		const json = new TextDecoder().decode(body);
		const parsed = JSON.parse(json) as unknown;
		if (!isIpcMessage(parsed)) {
			throw new Error(
				`decodeFrames: frame at offset ${offset} is not a valid IPC message`,
			);
		}
		messages.push(parsed);
		offset += 4 + length;
	}
	const remainder = buffer.subarray(offset);
	return { messages, remainder };
}
