import type { AgentEvent } from "./api-client.js";

type RuntimeStatusEvent = Extract<
	AgentEvent,
	{ type: "status" | "compaction" }
>;

export function formatWebRuntimeStatus(
	event: RuntimeStatusEvent,
): string | null {
	switch (event.type) {
		case "status":
			if (!event.status.trim()) {
				return null;
			}
			return event.status === "compacting"
				? "Compacting conversation..."
				: `Status: ${event.status}`;
		case "compaction":
			return event.auto
				? "Compacted conversation automatically"
				: "Compacted conversation";
	}
}
