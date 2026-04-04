import type { AgentEvent } from "./types";

export function formatDesktopRuntimeStatus(event: AgentEvent): string | null {
	if (event.type === "status") {
		const status = typeof event.status === "string" ? event.status.trim() : "";
		if (!status) {
			return null;
		}
		if (event.details?.kind === "tool_execution_summary") {
			return status;
		}
		return status === "compacting"
			? "Compacting conversation..."
			: `Status: ${status}`;
	}

	if (event.type === "compaction") {
		return event.auto
			? "Compacted conversation automatically"
			: "Compacted conversation";
	}

	return null;
}
