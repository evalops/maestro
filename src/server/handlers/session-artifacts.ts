import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerMessage } from "@evalops/contracts";
import { lookup as lookupMimeType } from "mime-types";
import { createLogger } from "../../utils/logger.js";
import {
	ARTIFACT_ACCESS_HEADER,
	type ArtifactAccessAction,
	getArtifactAccessGrantFromRequest,
	getArtifactAccessTokenFromRequest,
	issueArtifactAccessGrant,
} from "../artifact-access.js";
import { subscribeArtifactUpdates } from "../artifacts-live-reload.js";
import {
	ApiError,
	buildContentDisposition,
	sendJson,
} from "../server-utils.js";
import {
	createSessionManagerForRequest,
	resolveSessionScope,
} from "../session-scope.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

const logger = createLogger("session-artifacts");
const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;

function escapeScriptContent(code: string): string {
	return code.replace(/<\/script/gi, "<\\/script");
}

function injectLiveReload(html: string, eventsUrl: string): string {
	return injectLiveReloadWithAuth(html, eventsUrl);
}

function injectLiveReloadWithAuth(
	html: string,
	eventsUrl: string,
	accessToken?: string | null,
): string {
	const authHeaders = accessToken
		? `{ ${JSON.stringify(ARTIFACT_ACCESS_HEADER)}: ${JSON.stringify(accessToken)} }`
		: "undefined";
	const scriptBody = `
	(function() {
	  try {
	    const reload = () => location.reload();
	    const connect = ${
				accessToken
					? `async () => {
	      const response = await fetch(${JSON.stringify(eventsUrl)}, {
	        headers: ${authHeaders},
	        cache: "no-store",
	      });
	      if (!response.body) throw new Error("Missing response body");
	      const reader = response.body.getReader();
	      const decoder = new TextDecoder();
	      let buffer = "";
	      while (true) {
	        const { done, value } = await reader.read();
	        if (done) break;
	        buffer += decoder.decode(value, { stream: true });
	        let boundary = buffer.indexOf("\\n\\n");
	        while (boundary !== -1) {
	          const chunk = buffer.slice(0, boundary);
	          buffer = buffer.slice(boundary + 2);
	          const dataLine = chunk
	            .split("\\n")
	            .find((line) => line.startsWith("data:"));
	          if (dataLine) {
	            reload();
	            return;
	          }
	          boundary = buffer.indexOf("\\n\\n");
	        }
	      }
	    }`
					: `() => {
	      const es = new EventSource(${JSON.stringify(eventsUrl)});
	      es.onmessage = (e) => {
	        try {
	          const data = JSON.parse(e.data);
	          if (data && data.type === "artifact_updated") {
	            reload();
	          }
	        } catch (err) { console.error("[Composer] Failed to parse live reload event:", err); }
	      };
	    }`
			};
	    Promise.resolve(connect()).catch((err) => {
	      console.error("[Composer] Failed to setup live reload transport:", err);
	    });
	  } catch (err) { console.error("[Composer] Failed to setup live reload EventSource:", err); }
	})();
	`.trim();
	const script = `<script>\n${escapeScriptContent(scriptBody)}\n</script>`;
	const injected = `\n${script}\n`;
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
  } catch (err) {
    console.error("[Composer] Failed to initialize artifacts snapshot:", err);
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
	req: IncomingMessage,
	sessionId: string,
): Promise<ComposerMessage[]> {
	const sessionManager = createSessionManagerForRequest(req, true);
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

function buildSessionArtifactFileUrl(
	sessionId: string,
	filename: string,
	options?: {
		download?: boolean;
		raw?: boolean;
		standalone?: boolean;
	},
): string {
	const path = `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}`;
	const url = new URL(path, "http://localhost");
	if (options?.download) url.searchParams.set("download", "1");
	if (options?.raw) url.searchParams.set("raw", "1");
	if (options?.standalone) url.searchParams.set("standalone", "1");
	return `${url.pathname}${url.search}`;
}

function buildSessionArtifactViewerUrl(
	sessionId: string,
	filename: string,
): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(filename)}/view`;
}

function buildSessionArtifactsEventsUrl(
	sessionId: string,
	filename: string,
): string {
	const url = new URL(
		`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/events`,
		"http://localhost",
	);
	url.searchParams.set("filename", filename);
	return `${url.pathname}${url.search}`;
}

function buildSessionArtifactsZipUrl(sessionId: string): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts.zip`;
}

function resolveArtifactAccessContext(req: IncomingMessage): {
	accessToken: string | null;
	grant: ReturnType<typeof getArtifactAccessGrantFromRequest>;
} {
	const grant = getArtifactAccessGrantFromRequest(req);
	return {
		accessToken: grant ? getArtifactAccessTokenFromRequest(req) : null,
		grant,
	};
}

function canUseArtifactAccess(
	grant: ReturnType<typeof getArtifactAccessGrantFromRequest>,
	action: ArtifactAccessAction,
): boolean {
	return Boolean(grant?.actions.includes(action));
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

		const messages = await loadComposerMessages(req, sessionId);
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

export async function handleSessionArtifactAccess(
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
		const filename = url.searchParams.get("filename")?.trim() || undefined;
		const actions = Array.from(
			new Set(
				(url.searchParams.get("actions") || "")
					.split(",")
					.map((action) => action.trim())
					.filter(Boolean),
			),
		).filter((action): action is ArtifactAccessAction => {
			return ["view", "file", "events", "zip"].includes(action);
		});

		if (actions.length === 0) {
			sendJson(
				res,
				400,
				{ error: "At least one artifact access action is required" },
				cors,
				req,
			);
			return;
		}

		if (filename) {
			validateFilename(filename);
		}

		if (!filename && actions.some((action) => action !== "zip")) {
			sendJson(
				res,
				400,
				{ error: "filename is required for artifact file access" },
				cors,
				req,
			);
			return;
		}

		const messages = await loadComposerMessages(req, sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);

		if (filename && !artifacts.has(filename)) {
			sendJson(res, 404, { error: "Artifact not found" }, cors, req);
			return;
		}

		const access = issueArtifactAccessGrant({
			sessionId,
			scope: resolveSessionScope(req),
			filename,
			actions,
		});

		sendJson(
			res,
			200,
			{
				token: access.token,
				expiresAt: access.expiresAtIso,
				actions: access.actions,
				sessionId,
				...(filename ? { filename } : {}),
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

		const messages = await loadComposerMessages(req, sessionId);
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
		const { accessToken, grant } = resolveArtifactAccessContext(req);

		const eventsUrl = canUseArtifactAccess(grant, "events")
			? buildSessionArtifactsEventsUrl(sessionId, filename)
			: accessToken
				? null
				: buildSessionArtifactsEventsUrl(sessionId, filename);

		let body =
			isHtml && !wantsRaw && eventsUrl
				? injectLiveReloadWithAuth(content, eventsUrl, accessToken)
				: content;

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

		const messages = await loadComposerMessages(req, sessionId);
		const artifacts = reconstructArtifactsFromMessages(messages);
		const content = artifacts.get(filename);
		if (content === undefined) {
			sendJson(res, 404, { error: "Artifact not found" }, cors, req);
			return;
		}

		const mime = lookupMimeType(filename) || "text/plain; charset=utf-8";
		const isHtml = String(mime).startsWith("text/html");
		const { accessToken, grant } = resolveArtifactAccessContext(req);

		const title = `Composer Artifact · ${filename}`;
		const viewerUrl = buildSessionArtifactViewerUrl(sessionId, filename);

		const eventsUrl = canUseArtifactAccess(grant, "events")
			? buildSessionArtifactsEventsUrl(sessionId, filename)
			: accessToken
				? null
				: buildSessionArtifactsEventsUrl(sessionId, filename);
		const zipUrl = canUseArtifactAccess(grant, "zip")
			? buildSessionArtifactsZipUrl(sessionId)
			: accessToken
				? null
				: buildSessionArtifactsZipUrl(sessionId);
		const rawDownloadUrl = canUseArtifactAccess(grant, "file")
			? buildSessionArtifactFileUrl(sessionId, filename, {
					download: true,
					raw: true,
				})
			: accessToken
				? null
				: buildSessionArtifactFileUrl(sessionId, filename, {
						download: true,
						raw: true,
					});
		const standaloneDownloadUrl = isHtml
			? canUseArtifactAccess(grant, "file")
				? buildSessionArtifactFileUrl(sessionId, filename, {
						download: true,
						standalone: true,
					})
				: accessToken
					? null
					: buildSessionArtifactFileUrl(sessionId, filename, {
							download: true,
							standalone: true,
						})
			: null;

		const zipAction = zipUrl
			? accessToken
				? `<button id="download-zip" class="hint-button" type="button">Download ZIP</button>`
				: `<a class="hint" href="${zipUrl}" target="_blank" rel="noopener">Download ZIP</a>`
			: "";
		const rawDownloadAction = rawDownloadUrl
			? accessToken
				? `<button id="download-raw" class="hint-button" type="button">Download Raw</button>`
				: `<a class="hint" href="${rawDownloadUrl}" target="_blank" rel="noopener">Download Raw</a>`
			: "";
		const standaloneDownloadAction = standaloneDownloadUrl
			? accessToken
				? `<button id="download-standalone" class="hint-button" type="button">Download Standalone</button>`
				: `<a class="hint" href="${standaloneDownloadUrl}" target="_blank" rel="noopener">Download Standalone</a>`
			: "";
		const zipDownloadName = `${sessionId}-artifacts.zip`;

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
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return;
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
      .hint-button { padding: 0; border: 0; color: #7d8590; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="bar">
      <div class="title">${title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      <div class="spacer"></div>
      ${zipAction}
      ${rawDownloadAction}
      ${standaloneDownloadAction}
      <button id="reload">Reload</button>
    </div>
    ${openExternalHandler}
    <iframe id="frame" sandbox="allow-scripts allow-modals allow-downloads"></iframe>
    <script>
      const frame = document.getElementById("frame");
      const reloadBtn = document.getElementById("reload");
      const viewerUrl = ${JSON.stringify(viewerUrl)};
      const eventsUrl = ${JSON.stringify(eventsUrl)};
      const zipUrl = ${JSON.stringify(zipUrl)};
      const rawDownloadUrl = ${JSON.stringify(rawDownloadUrl)};
      const standaloneDownloadUrl = ${JSON.stringify(standaloneDownloadUrl)};
      const artifactAccessToken = ${JSON.stringify(accessToken)};
      const artifactAccessHeaders = artifactAccessToken
        ? { ${JSON.stringify(ARTIFACT_ACCESS_HEADER)}: artifactAccessToken }
        : undefined;

      const setDoc = (html) => {
        frame.srcdoc = html;
      };

      const parseDownloadFilename = (response, fallbackName) => {
        const contentDisposition = response.headers.get("content-disposition") || "";
        const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8Match?.[1]) {
          try {
            return decodeURIComponent(utf8Match[1]);
          } catch {
            return utf8Match[1];
          }
        }
        const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
        if (quotedMatch?.[1]) {
          return quotedMatch[1];
        }
        const bareMatch = contentDisposition.match(/filename=([^;]+)/i);
        return bareMatch?.[1]?.trim() || fallbackName || "";
      };

      const fetchViewerResource = async (url) => {
        const response = await fetch(url, {
          cache: "no-store",
          ...(artifactAccessHeaders ? { headers: artifactAccessHeaders } : {}),
        });
        if (!response.ok) {
		    throw new Error("Request failed (" + response.status + ")");
        }
        return response;
      };

      const downloadViewerResource = async (url, fallbackName) => {
        const response = await fetchViewerResource(url);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        const downloadName = parseDownloadFilename(response, fallbackName);
        if (downloadName) {
          link.download = downloadName;
        }
        link.rel = "noopener";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      };

      const refreshViewer = async () => {
        if (!artifactAccessHeaders) {
          location.reload();
          return;
        }
        const response = await fetchViewerResource(viewerUrl);
        const nextHtml = await response.text();
        const nextUrl = URL.createObjectURL(
          new Blob([nextHtml], { type: "text/html" }),
        );
        setTimeout(() => URL.revokeObjectURL(nextUrl), 60_000);
        location.replace(nextUrl);
      };

      const triggerRefresh = () => {
        void refreshViewer().catch((err) => {
          console.error("[Composer] Failed to refresh viewer:", err);
        });
      };

      const bindDownloadButton = (id, url, fallbackName) => {
        const button = document.getElementById(id);
        if (!button || !url || !artifactAccessHeaders) {
          return;
        }
        button.addEventListener("click", () => {
          void downloadViewerResource(url, fallbackName).catch((err) => {
            console.error("[Composer] Failed to download artifact:", err);
          });
        });
      };

      const srcdoc = ${JSON.stringify(srcdoc)};
      setDoc(srcdoc);

				bindDownloadButton("download-zip", zipUrl, ${JSON.stringify(zipDownloadName)});
      bindDownloadButton("download-raw", rawDownloadUrl, ${JSON.stringify(filename)});
      bindDownloadButton("download-standalone", standaloneDownloadUrl, ${JSON.stringify(filename)});

      reloadBtn.addEventListener("click", () => triggerRefresh());

      ${
				eventsUrl
					? `try {
		const reload = () => triggerRefresh();
        const connect = ${
					accessToken
						? `async () => {
		  const response = await fetchViewerResource(eventsUrl);
          if (!response.body) throw new Error("Missing response body");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf("\\n\\n");
            while (boundary !== -1) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = chunk
                .split("\\n")
                .find((line) => line.startsWith("data:"));
              if (dataLine) {
                reload();
                return;
              }
              boundary = buffer.indexOf("\\n\\n");
            }
          }
        }`
						: `() => {
          const es = new EventSource(${JSON.stringify(eventsUrl)});
          es.onmessage = () => reload();
        }`
				};
        Promise.resolve(connect()).catch((err) => {
          console.error("[Composer] Failed to setup viewer live reload transport:", err);
        });
      } catch (err) { console.error("[Composer] Failed to setup viewer EventSource:", err); }`
					: ""
			}
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

		let closed = false;
		const canWrite = () =>
			res.writable !== false && !res.writableEnded && !res.destroyed;
		const safeWrite = (payload: string) => {
			if (!canWrite()) return false;
			try {
				res.write(payload);
				return true;
			} catch {
				return false;
			}
		};

		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let unsubscribe: () => void = () => {};

		const cleanup = () => {
			if (closed) return;
			closed = true;
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = null;
			}
			unsubscribe();
			req.off("close", cleanup);
			res.off("close", cleanup);
		};

		unsubscribe = subscribeArtifactUpdates(sessionId, (event) => {
			if (filenameFilter && event.filename !== filenameFilter) return;
			if (!safeWrite(`data: ${JSON.stringify(event)}\n\n`)) {
				cleanup();
			}
		});

		heartbeat = setInterval(() => {
			if (!safeWrite(": ping\n\n")) {
				cleanup();
			}
		}, 15_000);

		if (heartbeat.unref) {
			heartbeat.unref();
		}

		if (!safeWrite(": ok\n\n")) {
			cleanup();
			return;
		}

		req.on("close", cleanup);
		res.on("close", cleanup);
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

		const messages = await loadComposerMessages(req, sessionId);
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
