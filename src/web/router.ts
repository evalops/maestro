import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	params: Record<string, string>,
) => Promise<void> | void;

export interface Route {
	method: string;
	path: string;
	handler: RouteHandler;
}

function toSegments(pathname: string): string[] {
	if (pathname === "/" || pathname === "") return [];
	return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

function matchPath(
	routePath: string,
	pathname: string,
): { matched: boolean; params: Record<string, string> } {
	const routeSegments = toSegments(routePath);
	const pathSegments = toSegments(pathname);

	if (routeSegments.length !== pathSegments.length) {
		return { matched: false, params: {} };
	}

	const params: Record<string, string> = {};
	for (let i = 0; i < routeSegments.length; i++) {
		const routeSegment = routeSegments[i];
		const pathSegment = pathSegments[i];
		if (routeSegment.startsWith(":")) {
			params[routeSegment.slice(1)] = pathSegment;
			continue;
		}
		if (routeSegment !== pathSegment) {
			return { matched: false, params: {} };
		}
	}

	return { matched: true, params };
}

export function matchRoute(
	method: string,
	pathname: string,
	routes: Route[],
): { handler: RouteHandler; params: Record<string, string> } | null {
	const targetMethod = method.toUpperCase();
	for (const route of routes) {
		if (route.method.toUpperCase() !== targetMethod) {
			continue;
		}
		const { matched, params } = matchPath(route.path, pathname);
		if (matched) {
			return { handler: route.handler, params };
		}
	}
	return null;
}

import { respondWithApiError } from "./server-utils.js";

export function createRequestHandler(
	routes: Route[],
	fallback?: (
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
	) => Promise<void> | void,
	corsHeaders: Record<string, string> = {},
) {
	return async (
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
	) => {
		try {
			const match = matchRoute(req.method || "GET", pathname, routes);
			if (match) {
				await match.handler(req, res, match.params);
				return;
			}
			if (fallback) {
				await fallback(req, res, pathname);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders);
		}
	};
}
