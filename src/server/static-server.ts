import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("web:static");

interface ServeStaticOptions {
	webRoot: string;
	corsHeaders?: Record<string, string>;
	maxAgeSeconds?: number;
	securityHeaders?: Record<string, string>;
	spaFallback?: boolean;
}

export function serveStatic(
	pathname: string,
	req: IncomingMessage,
	res: ServerResponse,
	options: ServeStaticOptions,
) {
	const { webRoot, corsHeaders, maxAgeSeconds = 0 } = options;
	const securityHeaders = options.securityHeaders || {};
	const safeRoot = resolve(webRoot);
	let filePath: string;

	if (pathname === "/" || pathname === "") {
		filePath = join(safeRoot, "index.html");
	} else {
		filePath = resolve(safeRoot, `.${pathname}`);
	}

	const relativePath = relative(safeRoot, filePath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	if (!existsSync(filePath)) {
		const accept =
			typeof req.headers.accept === "string" ? req.headers.accept : "";
		const lastSegment = (
			pathname.split("/").filter(Boolean).pop() || ""
		).trim();
		const looksLikeAsset = lastSegment.includes(".");
		const wantsHtml = accept.includes("text/html") || accept.includes("*/*");
		if (
			options.spaFallback &&
			req.method === "GET" &&
			wantsHtml &&
			!looksLikeAsset
		) {
			filePath = join(safeRoot, "index.html");
		} else {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}
	}

	const ext = filePath.split(".").pop();
	const contentTypes: Record<string, string> = {
		html: "text/html",
		js: "application/javascript",
		ts: "application/typescript",
		css: "text/css",
		json: "application/json",
		ico: "image/x-icon",
		png: "image/png",
		svg: "image/svg+xml",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
	};

	const contentType = contentTypes[ext || ""] || "text/plain";

	try {
		const stats = statSync(filePath);
		const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, {
				...(corsHeaders || {}),
				ETag: etag,
			});
			res.end();
			return;
		}

		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": stats.size,
			ETag: etag,
			...(maxAgeSeconds > 0
				? { "Cache-Control": `public, max-age=${maxAgeSeconds}` }
				: { "Cache-Control": "no-cache" }),
			...(corsHeaders || {}),
			...securityHeaders,
		});

		const stream = createReadStream(filePath);
		stream.on("error", (error) => {
			logger.error("Error serving file", error, { path: filePath });
			if (!res.writableEnded && !res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
			}
		});
		stream.pipe(res);
	} catch (error) {
		logger.error(
			"Error serving file",
			error instanceof Error ? error : undefined,
			{ path: pathname },
		);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal Server Error");
	}
}
