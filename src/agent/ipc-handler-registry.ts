/**
 * IPC handler registry
 *
 * Server-side complement to the request correlator (part 2 of #2658,
 * shipped as #2691). Where the correlator handles outbound requests
 * on the client, this registry routes inbound requests on the
 * daemon. Each method name maps to an async handler that produces a
 * typed result (or throws to produce an error response).
 *
 * The registry is pure: no transport, no socket — feed it an
 * `IpcRequest`, get back an `IpcResponse` you can hand to the
 * transport layer.
 *
 * Includes the hello-handshake helper: a built-in handler that
 * exchanges `IpcHelloParams` ↔ `IpcWelcomeResult` so clients always
 * know which methods/channels the daemon supports.
 */

import {
	IPC_PROTOCOL_VERSION,
	type IpcError,
	type IpcErrorResponse,
	type IpcHelloParams,
	type IpcRequest,
	type IpcResponse,
	type IpcSuccessResponse,
	type IpcWelcomeResult,
	makeErrorResponse,
	makeResponse,
	negotiateProtocolVersion,
} from "./ipc-envelope.js";

/** Async handler for a single RPC method. Throws to produce an error response. */
export type IpcHandler<TParams = unknown, TResult = unknown> = (
	params: TParams | undefined,
	ctx: IpcHandlerContext,
) => Promise<TResult> | TResult;

/** Context passed to every handler. */
export interface IpcHandlerContext {
	/** The request id (echoed back in the response). */
	requestId: string;
	/** The full method name dispatched. */
	method: string;
}

/** Error a handler can throw to produce a structured error response. */
export class IpcHandlerError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "IpcHandlerError";
	}
}

/** Public interface every handler registry implementation conforms to. */
export interface IpcHandlerRegistry {
	/**
	 * Register a handler for `method`. Throws if the method is already
	 * registered — methods are not silently overwritten, since that's
	 * almost always a bug.
	 */
	register<TParams = unknown, TResult = unknown>(
		method: string,
		handler: IpcHandler<TParams, TResult>,
	): void;
	/** True when a handler is registered for `method`. */
	has(method: string): boolean;
	/** List the registered method names, sorted ascending. */
	methods(): string[];
	/**
	 * Dispatch an inbound request. Returns the response to hand to the
	 * transport. Never throws — every error path lowers to an
	 * `IpcErrorResponse`.
	 */
	dispatch(request: IpcRequest): Promise<IpcResponse>;
	/**
	 * Drop a previously-registered handler. Returns `true` when one
	 * was removed.
	 */
	unregister(method: string): boolean;
}

export interface RegistryOptions {
	/** Channels the welcome handler should advertise. */
	channels?: string[];
	/** Daemon build identifier returned in `welcome.daemonBuild`. */
	daemonBuild?: string;
	/**
	 * Auto-register the built-in `hello` handler that negotiates
	 * protocol version + advertises methods/channels. Defaults to true.
	 * Disable when a caller wants to override the handshake.
	 */
	withHelloHandler?: boolean;
}

/**
 * Construct a fresh registry. Handlers register against this instance;
 * `dispatch` resolves the right one and produces a response.
 */
export function createIpcHandlerRegistry(
	options: RegistryOptions = {},
): IpcHandlerRegistry {
	const handlers = new Map<string, IpcHandler>();
	const channels = [...(options.channels ?? [])].sort();
	const daemonBuild = options.daemonBuild ?? "maestro-daemon/unknown";

	const registry: IpcHandlerRegistry = {
		register(method, handler) {
			if (!method.trim()) {
				throw new Error("IpcHandlerRegistry: method is required");
			}
			if (handlers.has(method)) {
				throw new Error(
					`IpcHandlerRegistry: method "${method}" already registered`,
				);
			}
			handlers.set(method, handler as IpcHandler);
		},
		has(method) {
			return handlers.has(method);
		},
		methods() {
			return [...handlers.keys()].sort();
		},
		unregister(method) {
			return handlers.delete(method);
		},
		async dispatch(request) {
			const handler = handlers.get(request.method);
			if (!handler) {
				return errorResponse(request.id, {
					code: "unknown-method",
					message: `no handler registered for method "${request.method}"`,
					details: { method: request.method },
				});
			}
			try {
				const result = await handler(request.params, {
					requestId: request.id,
					method: request.method,
				});
				return successResponse(request.id, result);
			} catch (err) {
				return errorResponse(request.id, normalizeError(err));
			}
		},
	};

	if (options.withHelloHandler !== false) {
		registry.register<IpcHelloParams, IpcWelcomeResult>("hello", (params) => {
			if (!params) {
				throw new IpcHandlerError(
					"bad-params",
					"hello requires { protocolVersion, client }",
				);
			}
			const negotiation = negotiateProtocolVersion(params.protocolVersion);
			if (!negotiation.ok) {
				throw new IpcHandlerError(
					"protocol-version-rejected",
					negotiation.reason,
					{ requestedVersion: params.protocolVersion },
				);
			}
			return {
				protocolVersion: negotiation.agreed,
				daemonBuild,
				methods: registry.methods(),
				channels: [...channels],
			};
		});
	}

	return registry;
}

/**
 * Convenience: build a hello param object for a client. Mirrors the
 * shape `dispatch` expects. Kept here so client + server share the
 * same `params` shape via the same module.
 */
export function makeHelloParams(input: {
	client: string;
	protocolVersion?: number;
	channels?: string[];
}): IpcHelloParams {
	const params: IpcHelloParams = {
		client: input.client,
		protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
	};
	if (input.channels !== undefined) {
		params.channels = input.channels;
	}
	return params;
}

function successResponse<T>(id: string, result: T): IpcSuccessResponse<T> {
	return makeResponse(id, result);
}

function errorResponse(id: string, error: IpcError): IpcErrorResponse {
	return makeErrorResponse(id, error);
}

function normalizeError(err: unknown): IpcError {
	if (err instanceof IpcHandlerError) {
		const error: IpcError = { code: err.code, message: err.message };
		if (err.details !== undefined) error.details = err.details;
		return error;
	}
	if (err instanceof Error) {
		return { code: "handler-failed", message: err.message };
	}
	return { code: "handler-failed", message: String(err) };
}
