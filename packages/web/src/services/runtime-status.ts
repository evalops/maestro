import type { AgentEvent } from "./api-client.js";

type RuntimeStatusEvent = Extract<
	AgentEvent,
	{ type: "status" | "compaction" | "tool_batch_summary" }
>;

export function formatWebRuntimeStatus(
	event: RuntimeStatusEvent,
): string | null {
	switch (event.type) {
		case "status": {
			const status = event.status.trim();
			if (!status) {
				return null;
			}
			if (event.details.kind === "tool_execution_summary") {
				return status;
			}
			return status === "compacting"
				? "Compacting conversation..."
				: `Status: ${status}`;
		}
		case "compaction":
			return event.auto
				? "Compacted conversation automatically"
				: "Compacted conversation";
		case "tool_batch_summary":
			return event.summary.trim() || null;
	}
}
