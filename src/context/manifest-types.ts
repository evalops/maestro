import type {
	PromptProjectDocDiagnostic,
	PromptProjectDocManifest,
} from "../config/index.js";

export const UNIFIED_CONTEXT_MANIFEST_PROTOCOL =
	"maestro.unified-context-manifest.v1" as const;

export type UnifiedContextEntryKind =
	| "project_doc"
	| "mcp_server"
	| "mcp_resource"
	| "mcp_prompt";

export type UnifiedContextEntrySource =
	| "filesystem"
	| "mcp_config"
	| "mcp_runtime";

export type UnifiedContextEntryStatus =
	| "available"
	| "configured"
	| "connected"
	| "disconnected"
	| "error"
	| "loaded";

export interface UnifiedContextManifestEntry {
	id: string;
	kind: UnifiedContextEntryKind;
	source: UnifiedContextEntrySource;
	status: UnifiedContextEntryStatus;
	label: string;
	path?: string;
	scopeDir?: string;
	serverName?: string;
	uri?: string;
	promptName?: string;
	precedenceIndex?: number;
	bytesRead?: number;
	contentHash?: string;
	metadata?: Record<string, unknown>;
}

export interface UnifiedContextManifestDiagnostic {
	code:
		| PromptProjectDocDiagnostic["code"]
		| "mcp_config_loaded"
		| "mcp_config_unreadable"
		| "mcp_runtime_unavailable";
	severity: "info" | "warning";
	message: string;
	path?: string;
	scopeDir?: string;
	entryId?: string;
}

export interface UnifiedContextManifest {
	protocolVersion: typeof UNIFIED_CONTEXT_MANIFEST_PROTOCOL;
	version: 1;
	cwd: string;
	projectDocs: PromptProjectDocManifest;
	entries: UnifiedContextManifestEntry[];
	diagnostics: UnifiedContextManifestDiagnostic[];
}

export interface UnifiedContextManifestDiffEntry {
	id: string;
	kind: UnifiedContextEntryKind;
	label: string;
	before?: UnifiedContextManifestEntry;
	after?: UnifiedContextManifestEntry;
	changes?: string[];
}

export interface UnifiedContextManifestDiff {
	beforeCwd: string;
	afterCwd: string;
	added: UnifiedContextManifestDiffEntry[];
	removed: UnifiedContextManifestDiffEntry[];
	changed: UnifiedContextManifestDiffEntry[];
	unchanged: UnifiedContextManifestDiffEntry[];
	diagnostics: UnifiedContextManifestDiagnostic[];
}

export interface UnifiedContextManifestContractIssue {
	path: string;
	message: string;
}
