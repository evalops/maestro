import {
	type RuntimeAppServerClientRequest,
	type RuntimeAppServerInitializeResult,
	type RuntimeAppServerModelProviderCapabilitiesResult,
	type RuntimeAppServerResponse,
	type RuntimeAppServerServerNotification,
	runtimeAppServerProtocolVersion,
} from "@evalops/contracts";
import type { WebSocket } from "ws";
import { getRegisteredModels } from "../../models/registry.js";
import {
	type ServerRequestLifecycleEvent,
	type ServerRequestManager,
	serverRequestManager as defaultServerRequestManager,
} from "../server-request-manager.js";

interface RuntimeAppServerOptions {
	serverRequestManager?: ServerRequestManager;
	sessionId?: string;
	validateSessionAccess?: (sessionId: string) => boolean | Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canWrite(ws: WebSocket): boolean {
	return ws.readyState === 1;
}

function send(
	ws: WebSocket,
	payload: RuntimeAppServerResponse | RuntimeAppServerServerNotification,
): void {
	if (!canWrite(ws)) return;
	try {
		ws.send(JSON.stringify(payload));
	} catch {
		// Disconnect races can close the socket after readyState is checked.
	}
}

function toErrorResponse(
	id: string | number | null,
	code: number,
	message: string,
): RuntimeAppServerResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	};
}

function parseClientRequest(raw: unknown): RuntimeAppServerClientRequest {
	if (!isRecord(raw)) {
		throw new Error("Runtime app-server request must be an object");
	}
	if (raw.jsonrpc !== "2.0") {
		throw new Error("Runtime app-server request must use JSON-RPC 2.0");
	}
	if (typeof raw.id !== "string" && typeof raw.id !== "number") {
		throw new Error("Runtime app-server request id must be a string or number");
	}
	if (
		raw.method !== "runtime.initialize" &&
		raw.method !== "runtime.model_provider_capabilities.read" &&
		raw.method !== "runtime.ping"
	) {
		throw new Error("Unsupported runtime app-server method");
	}
	return raw as RuntimeAppServerClientRequest;
}

function initializeResult(): RuntimeAppServerInitializeResult {
	return {
		protocolVersion: runtimeAppServerProtocolVersion,
		serverInfo: { name: "maestro" },
		capabilities: {
			chat: false,
			serverRequests: true,
			modelCapabilities: true,
		},
	};
}

function modelProviderCapabilities(): RuntimeAppServerModelProviderCapabilitiesResult {
	const providers = new Map<
		string,
		RuntimeAppServerModelProviderCapabilitiesResult["providers"][number]
	>();
	for (const model of getRegisteredModels()) {
		const provider = providers.get(model.provider) ?? {
			id: model.provider,
			name: model.providerName,
			models: [],
		};
		provider.models.push({
			id: model.id,
			name: model.name,
			api: model.api,
			provider: model.provider,
			source: model.source,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			capabilities: {
				streaming: true,
				tools: Boolean(model.toolUse),
				vision: model.input.includes("image"),
				reasoning: Boolean(model.reasoning),
				local: model.isLocal,
			},
		});
		providers.set(model.provider, provider);
	}
	return {
		providers: Array.from(providers.values()).sort((left, right) =>
			left.id.localeCompare(right.id),
		),
	};
}

function serverRequestMethod(event: ServerRequestLifecycleEvent) {
	return event.type === "registered"
		? "runtime.server_request.registered"
		: "runtime.server_request.resolved";
}

export function handleRuntimeAppServerWebSocket(
	ws: WebSocket,
	options: RuntimeAppServerOptions = {},
): void {
	const manager = options.serverRequestManager ?? defaultServerRequestManager;
	let sessionId = options.sessionId;
	let bindingSessionId: string | undefined;
	let initialized = false;
	const sentRegisteredRequestIds = new Set<string>();
	const sendServerRequestEvent = (event: ServerRequestLifecycleEvent): void => {
		if (event.type === "registered") {
			sentRegisteredRequestIds.add(event.request.id);
		}
		send(ws, {
			jsonrpc: "2.0",
			method: serverRequestMethod(event),
			params: event,
		});
	};
	const replayPendingServerRequests = (): void => {
		if (!initialized || !sessionId) {
			return;
		}
		for (const request of manager.listPending({ sessionId })) {
			if (sentRegisteredRequestIds.has(request.id)) {
				continue;
			}
			sendServerRequestEvent({
				type: "registered",
				request,
			});
		}
	};
	const bindSessionId = async (requestedSessionId: unknown): Promise<void> => {
		if (typeof requestedSessionId !== "string" || !requestedSessionId.trim()) {
			return;
		}
		const nextSessionId = requestedSessionId.trim();
		if (sessionId && sessionId !== nextSessionId) {
			throw new Error("Runtime app-server session is already bound");
		}
		if (bindingSessionId && bindingSessionId !== nextSessionId) {
			throw new Error(
				"Runtime app-server session binding is already in progress",
			);
		}
		bindingSessionId = nextSessionId;
		try {
			if (
				options.validateSessionAccess &&
				!(await options.validateSessionAccess(nextSessionId))
			) {
				throw new Error("Runtime app-server session access denied");
			}
			if (sessionId && sessionId !== nextSessionId) {
				throw new Error("Runtime app-server session is already bound");
			}
			sessionId = nextSessionId;
		} finally {
			if (bindingSessionId === nextSessionId) {
				bindingSessionId = undefined;
			}
		}
	};
	const unsubscribe = manager.subscribe((event) => {
		if (!initialized || !sessionId || event.request.sessionId !== sessionId) {
			return;
		}
		sendServerRequestEvent(event);
	});

	ws.on("message", async (data) => {
		let parsed: unknown;
		try {
			try {
				parsed = JSON.parse(String(data));
			} catch {
				send(ws, toErrorResponse(null, -32700, "Parse error"));
				return;
			}
			const request = parseClientRequest(parsed);
			if (request.method === "runtime.initialize") {
				const requestedSessionId = isRecord(request.params)
					? request.params.sessionId
					: undefined;
				await bindSessionId(requestedSessionId);
				const result = initializeResult();
				send(ws, { jsonrpc: "2.0", id: request.id, result });
				send(ws, {
					jsonrpc: "2.0",
					method: "runtime.initialized",
					params: result,
				});
				initialized = true;
				replayPendingServerRequests();
				return;
			}
			if (request.method === "runtime.model_provider_capabilities.read") {
				send(ws, {
					jsonrpc: "2.0",
					id: request.id,
					result: modelProviderCapabilities(),
				});
				return;
			}
			send(ws, { jsonrpc: "2.0", id: request.id, result: { ok: true } });
		} catch (error) {
			const id =
				isRecord(parsed) &&
				(typeof parsed.id === "string" || typeof parsed.id === "number")
					? parsed.id
					: null;
			send(
				ws,
				toErrorResponse(
					id,
					error instanceof Error &&
						error.message === "Unsupported runtime app-server method"
						? -32601
						: -32600,
					error instanceof Error ? error.message : "Invalid request",
				),
			);
		}
	});

	ws.on("close", () => {
		unsubscribe();
	});
}
