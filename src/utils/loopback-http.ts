import type { IncomingMessage, ServerResponse } from "node:http";

export function allowedLoopbackHosts(port: number): Set<string> {
	return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function isAllowedLoopbackHost(
	hostHeader: string | string[] | undefined,
	port: number,
): boolean {
	if (typeof hostHeader !== "string") {
		return false;
	}
	return allowedLoopbackHosts(port).has(hostHeader.trim().toLowerCase());
}

export function rejectDisallowedLoopbackHost(
	req: IncomingMessage,
	res: ServerResponse,
	port: number,
): boolean {
	if (isAllowedLoopbackHost(req.headers.host, port)) {
		return false;
	}
	res.writeHead(403, {
		"Cache-Control": "no-store",
		"Content-Type": "text/plain; charset=utf-8",
	});
	res.end("forbidden");
	return true;
}
