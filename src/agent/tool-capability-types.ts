export const TOOL_CAPABILITY_SCHEMA_VERSION =
	"evalops.maestro.tool-capability.v1";

export type ToolDomain =
	| "desktop"
	| "file"
	| "shell"
	| "web"
	| "mcp"
	| "unknown";
export type ToolRiskClass = "observe" | "low" | "medium" | "high";
export type ToolLane =
	| "desktop_observe"
	| "desktop_action"
	| "file_read"
	| "file_edit"
	| "shell_exec"
	| "web_access"
	| "mcp_meta"
	| "unknown";

export interface ToolCapabilityInput {
	server: string;
	toolName: string;
	annotations?: Record<string, unknown>;
}

export interface ToolCapabilityMetadata {
	schemaVersion: typeof TOOL_CAPABILITY_SCHEMA_VERSION;
	server: string;
	toolName: string;
	domain: ToolDomain;
	toolLane: ToolLane;
	riskClass: ToolRiskClass;
	requiresReceipt: boolean;
	proofRequired: boolean;
	mutatesDesktop: boolean;
	mutatesFiles: boolean;
	rawSecretPossible: boolean;
	readOnlyHint?: boolean;
}

export interface ToolCapabilitySummary {
	total: number;
	byDomain: Record<ToolDomain, number>;
	byRiskClass: Record<ToolRiskClass, number>;
	byToolLane: Record<ToolLane, number>;
	mutating: {
		desktop: number;
		files: number;
	};
	requiresReceipt: number;
	rawSecretPossible: number;
}
