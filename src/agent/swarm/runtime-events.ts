import { createLogger } from "../../utils/logger.js";
import type { SwarmEvent } from "./types.js";

const logger = createLogger("agent:swarm:runtime-events");

export interface SwarmRuntimeEvent {
	event: SwarmEvent;
	parentSessionId?: string;
	cwd: string;
	planFile: string;
}

export type SwarmRuntimeEventHandler = (event: SwarmRuntimeEvent) => void;

const runtimeEventHandlers = new Set<SwarmRuntimeEventHandler>();

export function subscribeSwarmRuntimeEvents(
	handler: SwarmRuntimeEventHandler,
): () => void {
	runtimeEventHandlers.add(handler);
	return () => {
		runtimeEventHandlers.delete(handler);
	};
}

export function publishSwarmRuntimeEvent(event: SwarmRuntimeEvent): void {
	for (const handler of runtimeEventHandlers) {
		try {
			handler(event);
		} catch (error) {
			logger.warn("Swarm runtime event handler failed", {
				error: error instanceof Error ? error.message : String(error),
				parentSessionId: event.parentSessionId,
				planFile: event.planFile,
				swarmId: event.event.swarmId,
				eventType: event.event.type,
			});
		}
	}
}
