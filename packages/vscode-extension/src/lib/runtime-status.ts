// @ts-ignore - type-only import from ESM module is safe in CJS context
import type * as Contracts from "@evalops/contracts";

type RuntimeStatusEvent = Extract<
	Contracts.ComposerAgentEvent,
	{ type: "status" | "compaction" }
>;

export function formatVscodeRuntimeStatus(
	event: RuntimeStatusEvent,
): string | undefined {
	switch (event.type) {
		case "status":
			if (!event.status.trim()) {
				return undefined;
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
