export interface Env {
	SESSION_HUB: DurableObjectNamespace;
}

const DEMO_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DO Session Hub Demo</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; margin: 24px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      input, textarea, button { font: inherit; padding: 8px; }
      textarea { width: 100%; min-height: 80px; }
      #log { border: 1px solid #ccc; padding: 12px; min-height: 240px; white-space: pre-wrap; background: #fafafa; }
      .meta { color: #666; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>DO Session Hub Demo</h1>
    <div class="row">
      <label>Session ID <input id="sessionId" value="demo-session" /></label>
      <button id="connect">Connect</button>
      <button id="replay">Replay</button>
    </div>
    <div class="row">
      <textarea id="payload" placeholder='Event payload (JSON or text)'></textarea>
    </div>
    <div class="row">
      <button id="send">Send Event</button>
      <span class="meta" id="status">Disconnected</span>
    </div>
    <div id="log"></div>

    <script>
      const logEl = document.getElementById("log");
      const sessionInput = document.getElementById("sessionId");
      const payloadInput = document.getElementById("payload");
      const statusEl = document.getElementById("status");
      const connectBtn = document.getElementById("connect");
      const replayBtn = document.getElementById("replay");
      const sendBtn = document.getElementById("send");

      let ws = null;
      let lastSeq = 0;
      let reconnectTimer = null;
      let connectToken = 0;
      let currentSessionId = "demo-session";
      let replayInFlight = false;
      let replayToken = 0;
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 5;

      function log(message) {
        logEl.textContent += message + "\\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function normalizeSessionId() {
        const trimmed = sessionInput.value.trim();
        const sessionId = trimmed || "demo-session";
        if (!trimmed) {
          sessionInput.value = sessionId;
        }
        if (sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          lastSeq = 0;
          replayToken += 1;
          replayInFlight = false;
          reconnectAttempts = 0;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          if (ws) {
            connectToken += 1;
            ws.close();
            ws = null;
            setStatus("Disconnected");
          }
        }
        return sessionId;
      }

      function wsUrl(sessionId) {
        const base = location.origin.replace(/^http/, "ws");
        return \`\${base}/sessions/\${encodeURIComponent(sessionId)}/ws?client=demo\`;
      }

      function eventsUrl(sessionId) {
        return \`\${location.origin}/sessions/\${encodeURIComponent(sessionId)}/events\`;
      }

      async function replay() {
        if (replayInFlight) {
          log("[replay] already running");
          return;
        }
        const sessionId = normalizeSessionId();
        const token = ++replayToken;
        replayInFlight = true;
        const limit = 100;
        const maxPages = 5;
        let replaySeq = lastSeq;
        let since = replaySeq;
        let page = 0;

        try {
          while (page < maxPages) {
            if (token !== replayToken) return;
            const url = \`\${eventsUrl(sessionId)}?since=\${since}&limit=\${limit}\`;
            let res;
            try {
              res = await fetch(url);
            } catch (error) {
              log(\`[replay] network error: \${error}\`);
              return;
            }
            if (token !== replayToken) return;
            if (!res.ok) {
              log(\`Replay failed: \${res.status}\`);
              return;
            }
            let data;
            try {
              data = await res.json();
            } catch (error) {
              log(\`[replay] invalid JSON: \${error}\`);
              return;
            }
            if (token !== replayToken) return;
            const events = Array.isArray(data.events) ? data.events : [];
            for (const event of events) {
              if (token !== replayToken) return;
              const eventSeq = event.seq || 0;
              replaySeq = Math.max(replaySeq, eventSeq);
              // Update lastSeq immediately so WebSocket filter has accurate state
              lastSeq = Math.max(lastSeq, eventSeq);
              log(\`[replay \${event.seq}] \${JSON.stringify(event.payload)}\`);
            }
            const sinceValue =
              typeof data.since === "number" ? data.since : since;
            const untilValue =
              typeof data.until === "number" ? data.until : replaySeq;
            if (events.length === 0 || untilValue - sinceValue < limit) {
              return;
            }
            since = Math.max(replaySeq, untilValue);
            page += 1;
          }

          log("[replay] truncated; click Replay again to continue.");
        } finally {
          if (token === replayToken) {
            replayInFlight = false;
          }
        }
      }

      function connect(options = {}) {
        if (options.manual) {
          reconnectAttempts = 0;
        }
        const sessionId = normalizeSessionId();
        const token = connectToken + 1;
        connectToken = token;
        const previousWs = ws;
        if (previousWs) {
          ws = null;
          previousWs.close();
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        ws = new WebSocket(wsUrl(sessionId));
        setStatus("Connecting...");

        ws.onopen = () => {
          if (token !== connectToken) return;
          setStatus("Connected");
          reconnectAttempts = 0;
          log("[ws] connected");
          replay();
        };
        ws.onmessage = (event) => {
          if (token !== connectToken) return;
          try {
            const data = JSON.parse(event.data);
            if (data.type === "event") {
              const seq = data.event.seq || 0;
              // Skip logging if replay is in flight and this event was already replayed.
              // Use < (not <=) to avoid dropping new events at the boundary.
              if (replayInFlight && seq < lastSeq) {
                return;
              }
              lastSeq = Math.max(lastSeq, seq);
              log(\`[event \${data.event.seq}] \${JSON.stringify(data.event.payload)}\`);
            } else {
              log(\`[ws] \${JSON.stringify(data)}\`);
            }
          } catch {
            log(\`[ws] \${event.data}\`);
          }
        };
        ws.onclose = (event) => {
          if (token !== connectToken) return;
          setStatus("Disconnected");
          replayToken += 1;
          replayInFlight = false;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          const code = event?.code ?? 1006;
          const noReconnectCodes = new Set([
            1000, // Normal closure
            1001, // Going Away
            1002, // Protocol error
            1003, // Unsupported data
            1007, // Invalid frame payload
            1008, // Policy violation
            1009, // Message too big
            1010, // Missing extension
            // 1011 (Internal Error) omitted to allow reconnects on server errors
          ]);
          if (noReconnectCodes.has(code)) {
            log(\`[ws] closed (\${code}); not reconnecting\`);
            return;
          }
          if (reconnectAttempts >= maxReconnectAttempts) {
            log("[ws] reconnect limit reached; giving up");
            return;
          }
          reconnectAttempts += 1;
          const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
          log(\`[ws] disconnected, retrying in \${delay}ms...\`);
          reconnectTimer = setTimeout(connect, delay);
        };
        ws.onerror = () => {
          if (token !== connectToken) return;
          log("[ws] error");
        };
      }

      connectBtn.addEventListener("click", () => connect({ manual: true }));
      replayBtn.addEventListener("click", replay);
      sendBtn.addEventListener("click", async () => {
        const sessionId = normalizeSessionId();
        const text = payloadInput.value.trim();
        if (!text) return;
        let payload = text;
        try { payload = JSON.parse(text); } catch {}
        let res;
        try {
          res = await fetch(eventsUrl(sessionId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (error) {
          log(\`[send] network error: \${error}\`);
          return;
        }
        if (!res.ok) {
          log(\`Send failed: \${res.status}\`);
        }
      });
    </script>
  </body>
</html>`;

function routeRequest(
	request: Request,
): { sessionId: string; action: string } | null {
	const url = new URL(request.url);
	const match = url.pathname.match(
		/^\/sessions\/([^/]+)(?:\/(ws|events|state))?$/,
	);
	if (!match) return null;
	return { sessionId: match[1], action: match[2] ?? "state" };
}

const handler: ExportedHandler<Env> = {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/demo") {
			return new Response(DEMO_HTML, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				},
			});
		}

		const route = routeRequest(request);
		if (!route) {
			return new Response("Not found", { status: 404 });
		}

		const id = env.SESSION_HUB.idFromName(route.sessionId);
		const stub = env.SESSION_HUB.get(id);

		url.pathname = `/${route.action}`;
		return stub.fetch(new Request(url.toString(), request));
	},
};

export default handler;
export { SessionHub } from "./session-hub";
