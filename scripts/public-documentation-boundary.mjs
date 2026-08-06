const publicDocumentationPaths = [
	"docs/AGENT_EVENTS.md",
	"docs/AGENT_PROFILES.md",
	"docs/ARCHITECTURE.md",
	"docs/ARCHITECTURE_DIAGRAM.md",
	"docs/BUILD_TESTING.md",
	"docs/CI_VERSION_PINS.md",
	"docs/CONDUCTOR_BRIDGE.md",
	"docs/CONTRIBUTOR_RUNBOOK.md",
	"docs/CUSTOM_AGENTS.md",
	"docs/ENTERPRISE.md",
	"docs/FEATURES.md",
	"docs/MCP_GUIDE.md",
	"docs/MODELS.md",
	"docs/NATIVE_INTEROP_AND_EXTENSIONS.md",
	"docs/NATIVE_TUI_PARITY.md",
	"docs/PROMPT_QUEUE.md",
	"docs/QUICKSTART.md",
	"docs/README.md",
	"docs/SAFETY.md",
	"docs/SESSIONS.md",
	"docs/THREAT_MODEL.md",
	"docs/TOOLS_REFERENCE.md",
	"docs/TUI_ARCHITECTURE.md",
	"docs/VSCODE_ARCHITECTURE.md",
	"docs/WEB_UI.md",
	"docs/cookbook",
	"docs/design/AGENT_SAFETY_BOUNDARY.md",
	"docs/design/AGENT_STATE_MACHINE.md",
	"docs/design/CONTEXT_MANAGEMENT.md",
	"docs/design/DATABASE_PERSISTENCE.md",
	"docs/design/ENTERPRISE_RBAC.md",
	"docs/design/GUARDED_FILES.md",
	"docs/design/HEADLESS_CONTROL_PLANE.md",
	"docs/design/HOOKS_SYSTEM.md",
	"docs/design/MCP_INTEGRATION.md",
	"docs/design/MCP_TRUST.md",
	"docs/design/OAUTH_AUTHENTICATION.md",
	"docs/design/PLATFORM_AGENT_RUNTIME_SESSION_BRIDGE.md",
	"docs/design/SAFETY_FIREWALL.md",
	"docs/design/SESSION_PERSISTENCE.md",
	"docs/design/TELEMETRY_COST.md",
	"docs/design/TOOL_SYSTEM.md",
	"docs/design/TUI_RENDERING.md",
	"docs/doc-path-allowlist.json",
	"docs/mcp-config.md",
	"docs/patterns",
	"docs/perf/MAGIC_TRACE.md",
	"docs/protocols",
	"docs/system-paths.json",
];

export const PUBLIC_DOCUMENTATION_PATHS = Object.freeze(
	[...publicDocumentationPaths].sort(),
);

export function isPublicDocumentationPath(path) {
	const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//u, "");
	return PUBLIC_DOCUMENTATION_PATHS.some(
		(publicPath) =>
			normalized === publicPath || normalized.startsWith(`${publicPath}/`),
	);
}
