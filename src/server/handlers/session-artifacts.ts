import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerMessage } from "@evalops/contracts";
import { lookup as lookupMimeType } from "mime-types";
import { SessionManager } from "../../session/manager.js";
import { createLogger } from "../../utils/logger.js";
import { subscribeArtifactUpdates } from "../artifacts-live-reload.js";
import {
	ApiError,
	buildContentDisposition,
	sendJson,
} from "../server-utils.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

const logger = createLogger("session-artifacts");
const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;

function escapeScriptContent(code: string): string {
	return code.replace(/<\/script/gi, "<\\/script");
}

function injectLiveReload(html: string, eventsUrl: string): string {
	const script = `
<script>
(function() {
  try {
    const es = new EventSource(${JSON.stringify(eventsUrl)});
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.type === "artifact_updated") {
          location.reload();
        }
      } catch (_) {}
    };
  } catch (_) {}
})();
</script>
`.trim();
	const injected = `\n${escapeScriptContent(script)}\n`;
	if (/<\/body>/i.test(html)) {
		return html.replace(/<\/body>/i, `${injected}</body>`);
	}
	return `${html}${injected}`;
}

function wrapHtmlDocument(htmlContent: string): string {
	const trimmed = htmlContent.trim();
	const looksLikeDocument =
		/^<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed);

	if (looksLikeDocument) return trimmed;

	return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
${trimmed}
  </body>
</html>`;
}

function injectArtifactsSnapshotRuntime(
	htmlContent: string,
	artifacts: Map<string, string>,
): string {
	const snapshot: Record<string, string> = {};
	for (const [name, content] of artifacts) {
		snapshot[name] = content;
	}

	const runtime = `
<script>
(function() {
  try {
    window.artifacts = ${escapeScriptContent(JSON.stringify(snapshot))};
  } catch (_) {
    window.artifacts = {};
  }

  const isJson = (f) => (f || "").toLowerCase().endsWith(".json");

  window.listArtifacts = async () => Object.keys(window.artifacts || {});

  window.getArtifact = async (filename) => {
    const content = (window.artifacts || {})[filename];
    if (typeof content !== "string") throw new Error("Artifact not found: " + filename);
    if (isJson(filename)) {
      try { return JSON.parse(content); } catch (e) { throw new Error("Failed to parse JSON: " + e); }
    }
    return content;
  };
})();
</script>
`.trim();

	const html = wrapHtmlDocument(htmlContent);
	if (/<\/body>/i.test(html)) {
		return html.replace(/<\/body>/i, `\n${runtime}\n</body>`);
	}
	return `${html}\n${runtime}`;
}

type ArtifactsCommand =
	| "create"
	| "update"
	| "rewrite"
	| "get"
	| "delete"
	| "logs";

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function reconstructArtifactsFromMessages(
	messages: ComposerMessage[],
): Map<string, string> {
	const byFilename = new Map<string, string>();

	for (const msg of messages) {
		const tools = msg.tools ?? [];
		for (const tool of tools) {
			if (tool.name !== "artifacts") continue;
			if (tool.status !== "completed") continue;
			if (tool.result && typeof tool.result === "object") {
				const maybeErr = tool.result as { isError?: boolean };
				if (maybeErr.isError) continue;
			}

			const args = (
				tool.args && typeof tool.args === "object"
					? (tool.args as Record<string, unknown>)
					: {}
			) as Record<string, unknown>;

			const command = asString(args.command) as ArtifactsCommand | undefined;
			const filename = asString(args.filename)?.trim();

			if (!command || !filename) continue;
			if (command === "get" || command === "logs") continue;

			if (command === "create") {
				if (byFilename.has(filename)) continue;
				byFilename.set(filename, asString(args.content) ?? "");
				continue;
			}

			if (command === "rewrite") {
				if (!byFilename.has(filename)) continue;
				byFilename.set(filename, asString(args.content) ?? "");
				continue;
			}

			if (command === "update") {
				const current = byFilename.get(filename);
				if (current === undefined) continue;
				const oldStr = asString(args.old_str);
				const newStr = asString(args.new_str);
				if (oldStr === undefined || newStr === undefined) continue;
				if (!current.includes(oldStr)) continue;
				byFilename.set(filename, current.replace(oldStr, newStr));
				continue;
			}

			if (command === "delete") {
				byFilename.delete(filename);
			}
		}
	}

	return byFilename;
}

async function loadComposerMessages(
	sessionId: string,
): Promise<ComposerMessage[]> {
	const sessionManager = new SessionManager(true);
	const session = await sessionManager.loadSession(sessionId);
	if (!session) {
		throw new ApiError(404, "Session not found");
	}
	return convertAppMessagesToComposer(session.messages || []);
}

function validateFilename(filename: string): void {
	// Keep this strict: no path traversal, no folder hierarchies.
	if (
		filename.includes("..") ||
		filename.includes("/") ||
		filename.includes("\\")
	) {
		throw new ApiError(400, "Invalid filename");
	}
}

export async function handleSessionArtifactsIndex(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionId = params.id;
	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}

		const messages = await loadComposerMessages(sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);
		sendJson(
			res,
			200,
			{
				sessionId,
				filenames: Array.from(artifacts.keys()).sort((a, b) =>
					a.localeCompare(b),
				),
			},
			cors,
			req,
		);
	} catch (err) {
		const error =
			err instanceof ApiError ? err : new ApiError(500, "Internal error");
		sendJson(res, error.statusCode, { error: error.message }, cors, req);
	}
}

export async function handleSessionArtifactFile(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string; filename: string },
	cors: Record<string, string>,
) {
	const sessionId = params.id;
	const filename = decodeURIComponent(params.filename || "");

	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}
		validateFilename(filename);

		const messages = await loadComposerMessages(sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);
		const content = artifacts.get(filename);
		if (content === undefined) {
			sendJson(res, 404, { error: "Artifact not found" }, cors, req);
			return;
		}

		const url = new URL(req.url || "", "http://localhost");
		const wantsDownload = url.searchParams.get("download") === "1";
		const wantsRaw = url.searchParams.get("raw") === "1";
		const wantsStandalone = url.searchParams.get("standalone") === "1";

		const mime = lookupMimeType(filename) || "text/plain; charset=utf-8";
		const isHtml = String(mime).startsWith("text/html");

		const eventsUrl = `/api/sessions/${encodeURIComponent(
			sessionId,
		)}/artifacts/events?filename=${encodeURIComponent(filename)}`;

		let body =
			isHtml && !wantsRaw ? injectLiveReload(content, eventsUrl) : content;

		// Standalone download: force attachment and embed artifacts snapshot + helpers.
		if (isHtml && wantsStandalone) {
			body = injectArtifactsSnapshotRuntime(body, artifacts);
		}

		res.writeHead(200, {
			"Content-Type": String(mime),
			"Cache-Control": "no-store",
			...(wantsDownload || wantsStandalone
				? {
						"Content-Disposition": buildContentDisposition(filename),
					}
				: {}),
			...cors,
		});
		res.end(body);
	} catch (err) {
		logger.warn("Failed to serve artifact", {
			err: err instanceof Error ? err.message : String(err),
			sessionId,
			filename,
		});
		const error =
			err instanceof ApiError ? err : new ApiError(500, "Internal error");
		sendJson(res, error.statusCode, { error: error.message }, cors, req);
	}
}

export async function handleSessionArtifactViewer(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string; filename: string },
	cors: Record<string, string>,
) {
	const sessionId = params.id;
	const filename = decodeURIComponent(params.filename || "");

	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}
		validateFilename(filename);

		const messages = await loadComposerMessages(sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);
		const content = artifacts.get(filename);
		if (content === undefined) {
			sendJson(res, 404, { error: "Artifact not found" }, cors, req);
			return;
		}

		const mime = lookupMimeType(filename) || "text/plain; charset=utf-8";
		const isHtml = String(mime).startsWith("text/html");

		const title = `Composer Artifact · ${filename}`;

		const eventsUrl = `/api/sessions/${encodeURIComponent(
			sessionId,
		)}/artifacts/events?filename=${encodeURIComponent(filename)}`;

		const srcdoc = isHtml
			? injectArtifactsSnapshotRuntime(content, artifacts)
			: wrapHtmlDocument(
					`<pre style="white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.4; padding: 16px; margin: 0;">${content
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;")}</pre>`,
				);

		const openExternalHandler = `
<script>
window.addEventListener("message", (e) => {
  if (!e || !e.data) return;
  if (e.data.type !== "open-external-url") return;
  const url = e.data.url;
  if (typeof url !== "string") return;
  window.open(url, "_blank", "noopener,noreferrer");
});
</script>
`.trim();

		const viewerHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0b0c0f; color: #e6edf3; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .bar { display:flex; align-items:center; gap:12px; padding:10px 12px; border-bottom: 1px solid #1e2023; background: #08090a; position: sticky; top: 0; z-index: 1; }
      .title { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: #9da3af; }
      .spacer { flex: 1; }
      a, button { font: inherit; }
      button { background: transparent; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; cursor: pointer; }
      button:hover { border-color: #58a6ff; color: #58a6ff; }
      iframe { width: 100%; height: calc(100% - 52px); border: 0; display:block; background: #fff; }
      .hint { font-size: 12px; color: #7d8590; }
    </style>
  </head>
  <body>
    <div class="bar">
      <div class="title">${title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      <div class="spacer"></div>
      <a class="hint" href="/api/sessions/${encodeURIComponent(
				sessionId,
			)}/artifacts.zip" target="_blank" rel="noopener">Download ZIP</a>
      <a class="hint" href="/api/sessions/${encodeURIComponent(
				sessionId,
			)}/artifacts/${encodeURIComponent(
				filename,
			)}?download=1&raw=1" target="_blank" rel="noopener">Download Raw</a>
      ${
				isHtml
					? `<a class="hint" href="/api/sessions/${encodeURIComponent(
							sessionId,
						)}/artifacts/${encodeURIComponent(
							filename,
						)}?download=1&standalone=1" target="_blank" rel="noopener">Download Standalone</a>`
					: ""
			}
      <button id="reload">Reload</button>
    </div>
    ${openExternalHandler}
    <iframe id="frame" sandbox="allow-scripts allow-modals allow-downloads"></iframe>
    <script>
      const frame = document.getElementById("frame");
      const reloadBtn = document.getElementById("reload");

      const setDoc = (html) => {
        frame.srcdoc = html;
      };

      const srcdoc = ${JSON.stringify(srcdoc)};
      setDoc(srcdoc);

      reloadBtn.addEventListener("click", () => location.reload());

      try {
        const es = new EventSource(${JSON.stringify(eventsUrl)});
        es.onmessage = () => location.reload();
      } catch (_) {}
    </script>
  </body>
</html>`;

		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			...cors,
		});
		res.end(viewerHtml);
	} catch (err) {
		const error =
			err instanceof ApiError ? err : new ApiError(500, "Internal error");
		sendJson(res, error.statusCode, { error: error.message }, cors, req);
	}
}

export async function handleSessionArtifactsEvents(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionId = params.id;
	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}

		const url = new URL(req.url || "", "http://localhost");
		const filenameFilter = url.searchParams.get("filename");

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...cors,
		});

		res.write(": ok\n\n");

		const unsubscribe = subscribeArtifactUpdates(sessionId, (event) => {
			if (filenameFilter && event.filename !== filenameFilter) return;
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		});

		const heartbeat = setInterval(() => {
			res.write(": ping\n\n");
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	} catch (err) {
		const error =
			err instanceof ApiError ? err : new ApiError(500, "Internal error");
		sendJson(res, error.statusCode, { error: error.message }, cors, req);
	}
}

export async function handleSessionArtifactsZip(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionId = params.id;
	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}

		const messages = await loadComposerMessages(sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);

		// Lazy import to keep startup cost low.
		const { strToU8, zipSync } = await import("fflate");

		const entries: Record<string, Uint8Array> = {};
		for (const [filename, content] of artifacts) {
			entries[filename] = strToU8(content);
		}

		const zipBytes = zipSync(entries, { level: 6 });

		res.writeHead(200, {
			"Content-Type": "application/zip",
			"Content-Disposition": buildContentDisposition(
				`artifacts-${sessionId}.zip`,
			),
			"Cache-Control": "no-store",
			...cors,
		});
		res.end(Buffer.from(zipBytes));
	} catch (err) {
		logger.warn("Failed to export artifacts zip", {
			err: err instanceof Error ? err.message : String(err),
			sessionId,
		});
		const error =
			err instanceof ApiError ? err : new ApiError(500, "Internal error");
		sendJson(res, error.statusCode, { error: error.message }, cors, req);
	}
}
