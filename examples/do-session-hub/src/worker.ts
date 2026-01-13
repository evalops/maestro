export interface Env {
	SESSION_HUB: DurableObjectNamespace;
}

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
		const route = routeRequest(request);
		if (!route) {
			return new Response("Not found", { status: 404 });
		}

		const id = env.SESSION_HUB.idFromName(route.sessionId);
		const stub = env.SESSION_HUB.get(id);

		const url = new URL(request.url);
		url.pathname = `/${route.action}`;
		return stub.fetch(new Request(url.toString(), request));
	},
};

export default handler;
export { SessionHub } from "./session-hub";
