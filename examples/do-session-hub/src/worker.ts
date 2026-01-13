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

      function log(message) {
        logEl.textContent += message + "\\n";
        logEl.scrollTop = logEl.scrollHeight;
      }

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function wsUrl() {
        const base = location.origin.replace(/^http/, "ws");
        return \`\${base}/sessions/\${encodeURIComponent(sessionInput.value)}/ws?client=demo\`;
      }

      function eventsUrl() {
        return \`\${location.origin}/sessions/\${encodeURIComponent(sessionInput.value)}/events\`;
      }

      async function replay() {
        const url = \`\${eventsUrl()}?since=\${lastSeq}&limit=100\`;
        const res = await fetch(url);
        if (!res.ok) {
          log(\`Replay failed: \${res.status}\`);
          return;
        }
        const data = await res.json();
        for (const event of data.events || []) {
          lastSeq = Math.max(lastSeq, event.seq || 0);
          log(\`[replay \${event.seq}] \${JSON.stringify(event.payload)}\`);
        }
      }

      function connect() {
        if (ws) ws.close();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        ws = new WebSocket(wsUrl());
        setStatus("Connecting...");

        ws.onopen = () => {
          setStatus("Connected");
          log("[ws] connected");
          replay();
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "event") {
              lastSeq = Math.max(lastSeq, data.event.seq || 0);
              log(\`[event \${data.event.seq}] \${JSON.stringify(data.event.payload)}\`);
            } else {
              log(\`[ws] \${JSON.stringify(data)}\`);
            }
          } catch {
            log(\`[ws] \${event.data}\`);
          }
        };
        ws.onclose = () => {
          setStatus("Disconnected");
          log("[ws] disconnected, retrying...");
          reconnectTimer = setTimeout(connect, 1000);
        };
        ws.onerror = () => {
          log("[ws] error");
        };
      }

      connectBtn.addEventListener("click", connect);
      replayBtn.addEventListener("click", replay);
      sendBtn.addEventListener("click", async () => {
        const text = payloadInput.value.trim();
        if (!text) return;
        let payload = text;
        try { payload = JSON.parse(text); } catch {}
        const res = await fetch(eventsUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
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
