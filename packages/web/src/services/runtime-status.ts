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
			const status = event.status.trim();
			if (!status) {
				return null;
			}
			return status === "compacting"
				? "Compacting conversation..."
				: `Status: ${status}`;
		case "compaction":
			return event.auto
				? "Compacted conversation automatically"
				: "Compacted conversation";
	}
}
