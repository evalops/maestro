import type { IncomingMessage } from "node:http";

export interface InFlightRequest {
	id: string;
	method: string;
	url: string;
	startTime: number;
	userAgent?: string;
}

class RequestTracker {
	private activeRequests = new Map<IncomingMessage, InFlightRequest>();

	track(req: IncomingMessage, context: InFlightRequest) {
		this.activeRequests.set(req, context);
	}

	untrack(req: IncomingMessage) {
		this.activeRequests.delete(req);
	}

	getCount(): number {
		return this.activeRequests.size;
	}

	getSnapshot(): InFlightRequest[] {
		return Array.from(this.activeRequests.values()).sort(
			(a, b) => a.startTime - b.startTime,
		);
	}

	getLongRunning(thresholdMs: number): InFlightRequest[] {
		const now = performance.now();
		return this.getSnapshot().filter(
			(req) => now - req.startTime > thresholdMs,
		);
	}
}

export const requestTracker = new RequestTracker();
