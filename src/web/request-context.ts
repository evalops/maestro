import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
	requestId: string;
	startTime: number;
	method: string;
	url: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string {
	const store = requestContextStorage.getStore();
	return store?.requestId || "unknown";
}

export function getRequestContext(): RequestContext | undefined {
	return requestContextStorage.getStore();
}
