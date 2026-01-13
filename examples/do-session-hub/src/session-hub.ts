type HubEvent = {
	seq: number;
	payload: unknown;
	ts: number;
};

type ClientMessage =
	| { type: "hello"; clientId?: string; clientType?: string }
	| { type: "ack"; seq: number }
	| { type: "ping" }
	| { type: "request_state" };

type ClientAttachment = {
	clientType: string;
	lastAckSeq: number;
};

export class SessionHub {
	private readonly state: DurableObjectState;
	private seq = 0;
	private loaded = false;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/ws":
				return this.handleWebSocket(request);
			case "/events":
				return this.handleEvents(request);
			case "/state":
				return this.handleState(request);
			default:
				return new Response("Not found", { status: 404 });
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const storedSeq = await this.state.storage.get<number>("seq");
		this.seq = storedSeq ?? 0;
		this.loaded = true;
	}

	private handleWebSocket(request: Request): Response {
		const upgrade = request.headers.get("Upgrade");
		if (!upgrade || upgrade.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

		const url = new URL(request.url);
		const clientType = url.searchParams.get("client") ?? "unknown";

		this.state.acceptWebSocket(server, [clientType]);
		const attachment: ClientAttachment = { clientType, lastAckSeq: 0 };
		server.serializeAttachment(JSON.stringify(attachment));

		return new Response(null, { status: 101, webSocket: client });
	}

	private async handleEvents(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		await this.ensureLoaded();
		const payload = await request.json();
		const seq = ++this.seq;
		const event: HubEvent = { seq, payload, ts: Date.now() };

		await this.state.storage.put("seq", seq);
		await this.state.storage.put(`event:${seq}`, event);

		this.broadcast({ type: "event", event });

		return Response.json({ ok: true, seq });
	}

	private async handleState(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return new Response("Method not allowed", { status: 405 });
		}

		await this.ensureLoaded();
		const meta = await this.state.storage.get<Record<string, unknown>>("meta");
		return Response.json({ seq: this.seq, meta });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message !== "string") return;
		let parsed: ClientMessage | null = null;
		try {
			parsed = JSON.parse(message) as ClientMessage;
		} catch {
			return;
		}

		switch (parsed.type) {
			case "ack": {
				const attachment = this.readAttachment(ws);
				const updated: ClientAttachment = {
					clientType: attachment?.clientType ?? "unknown",
					lastAckSeq: parsed.seq,
				};
				ws.serializeAttachment(JSON.stringify(updated));
				break;
			}
			case "request_state": {
				ws.send(JSON.stringify({ type: "state", seq: this.seq }));
				break;
			}
			case "ping": {
				ws.send(JSON.stringify({ type: "pong" }));
				break;
			}
			default:
				break;
		}
	}

	webSocketClose(
		_ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): void {}

	webSocketError(_ws: WebSocket, _error: unknown): void {}

	private broadcast(message: unknown): void {
		const payload = JSON.stringify(message);
		for (const ws of this.state.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// Ignore failures; clients will reconnect.
			}
		}
	}

	private readAttachment(ws: WebSocket): ClientAttachment | null {
		const attachment = ws.deserializeAttachment();
		if (typeof attachment !== "string") return null;
		try {
			return JSON.parse(attachment) as ClientAttachment;
		} catch {
			return null;
		}
	}
}
