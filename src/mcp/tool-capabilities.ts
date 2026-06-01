import {
	TOOL_CAPABILITY_SCHEMA_VERSION,
	type ToolCapabilityInput,
	type ToolCapabilityMetadata,
	type ToolCapabilitySummary,
	type ToolDomain,
	type ToolLane,
	type ToolRiskClass,
} from "../agent/tool-capability-types.js";

export {
	TOOL_CAPABILITY_SCHEMA_VERSION,
	type ToolCapabilityInput,
	type ToolCapabilityMetadata,
	type ToolCapabilitySummary,
	type ToolDomain,
	type ToolLane,
	type ToolRiskClass,
};

const DESKTOP_OBSERVE_TOOLS = new Set([
	"get_app_state",
	"list_apps",
	"tool_search",
	"wait_for_ui_change",
]);

const DESKTOP_RAW_SECRET_TOOLS = new Set([
	"paste_text",
	"select_text",
	"set_text_selection",
	"set_value",
	"type_text",
]);

const DESKTOP_HIGH_RISK_TOOLS = new Set([
	"activate_menu_item",
	"drag",
	"move_mouse",
	"paste_text",
	"press_window_button",
	"scroll",
	"set_window_bounds",
	"set_window_minimized",
]);

const FATHOM_DESKTOP_TOOLS = new Set([
	...DESKTOP_OBSERVE_TOOLS,
	"activate_app",
	"activate_menu_item",
	"click",
	"decrement_element",
	"double_click",
	"drag",
	"focus_element",
	"increment_element",
	"move_mouse",
	"open_context_menu",
	"paste_text",
	"perform_secondary_action",
	"press_element",
	"press_key",
	"press_window_button",
	"raise_window",
	"scroll",
	"scroll_to_element",
	"select_context_menu_item",
	"select_list_item",
	"select_menu_option",
	"select_radio_button",
	"select_text",
	"set_disclosure_expanded",
	"set_slider_value",
	"set_text_selection",
	"set_toggle_state",
	"set_value",
	"set_window_bounds",
	"set_window_minimized",
	"type_text",
]);

const FILE_READ_TOOLS = new Set([
	"diff",
	"extract_document",
	"find",
	"jetbrains_read_file_range",
	"list",
	"parallel_ripgrep",
	"read",
	"search",
	"vscode_read_file_range",
]);

const FILE_EDIT_TOOLS = new Set([
	"apply_patch",
	"edit",
	"notebook_edit",
	"write",
]);

const SHELL_TOOLS = new Set(["background_tasks", "bash"]);
const WEB_TOOLS = new Set(["codesearch", "webfetch", "websearch"]);
const MCP_META_TOOLS = new Set([
	"get_mcp_prompt",
	"list_mcp_prompts",
	"list_mcp_resources",
	"read_mcp_resource",
]);
const FATHOM_SERVER_NAME_ENV_VARS = [
	"MAESTRO_FATHOM_CUA_MCP_NAME",
	"FATHOM_CUA_MCP_NAME",
] as const;

function readOnlyHint(
	annotations: Record<string, unknown> | undefined,
): boolean | undefined {
	const value = annotations?.readOnlyHint;
	return typeof value === "boolean" ? value : undefined;
}

function baseCapability(
	input: ToolCapabilityInput,
): Pick<
	ToolCapabilityMetadata,
	"schemaVersion" | "server" | "toolName" | "readOnlyHint"
> {
	return {
		schemaVersion: TOOL_CAPABILITY_SCHEMA_VERSION,
		server: input.server,
		toolName: input.toolName,
		...(readOnlyHint(input.annotations) !== undefined
			? { readOnlyHint: readOnlyHint(input.annotations) }
			: {}),
	};
}

function isFathomDesktopTool(input: ToolCapabilityInput): boolean {
	return (
		isFathomServerName(input.server) && FATHOM_DESKTOP_TOOLS.has(input.toolName)
	);
}

function isFathomServerName(server: string): boolean {
	if (server === "fathom-cua") {
		return true;
	}
	return FATHOM_SERVER_NAME_ENV_VARS.some(
		(name) => process.env[name]?.trim() === server,
	);
}

export function classifyToolCapability(
	input: ToolCapabilityInput,
): ToolCapabilityMetadata {
	const base = baseCapability(input);
	const toolName = input.toolName;

	if (isFathomDesktopTool(input)) {
		const observe = DESKTOP_OBSERVE_TOOLS.has(toolName);
		const riskClass: ToolRiskClass = observe
			? "observe"
			: DESKTOP_HIGH_RISK_TOOLS.has(toolName)
				? "high"
				: "medium";
		return {
			...base,
			domain: "desktop",
			toolLane: observe ? "desktop_observe" : "desktop_action",
			riskClass,
			requiresReceipt: true,
			proofRequired: true,
			mutatesDesktop: !observe,
			mutatesFiles: false,
			rawSecretPossible: DESKTOP_RAW_SECRET_TOOLS.has(toolName),
		};
	}

	if (FILE_READ_TOOLS.has(toolName)) {
		return {
			...base,
			domain: "file",
			toolLane: "file_read",
			riskClass: "observe",
			requiresReceipt: false,
			proofRequired: false,
			mutatesDesktop: false,
			mutatesFiles: false,
			rawSecretPossible: false,
		};
	}

	if (FILE_EDIT_TOOLS.has(toolName)) {
		return {
			...base,
			domain: "file",
			toolLane: "file_edit",
			riskClass: "medium",
			requiresReceipt: false,
			proofRequired: true,
			mutatesDesktop: false,
			mutatesFiles: true,
			rawSecretPossible: true,
		};
	}

	if (SHELL_TOOLS.has(toolName)) {
		return {
			...base,
			domain: "shell",
			toolLane: "shell_exec",
			riskClass: "high",
			requiresReceipt: false,
			proofRequired: true,
			mutatesDesktop: false,
			mutatesFiles: true,
			rawSecretPossible: true,
		};
	}

	if (WEB_TOOLS.has(toolName)) {
		return {
			...base,
			domain: "web",
			toolLane: "web_access",
			riskClass: "low",
			requiresReceipt: false,
			proofRequired: false,
			mutatesDesktop: false,
			mutatesFiles: false,
			rawSecretPossible: false,
		};
	}

	if (MCP_META_TOOLS.has(toolName)) {
		return {
			...base,
			domain: "mcp",
			toolLane: "mcp_meta",
			riskClass: "observe",
			requiresReceipt: false,
			proofRequired: false,
			mutatesDesktop: false,
			mutatesFiles: false,
			rawSecretPossible: false,
		};
	}

	return {
		...base,
		domain: "unknown",
		toolLane: "unknown",
		riskClass: readOnlyHint(input.annotations) === true ? "observe" : "medium",
		requiresReceipt: false,
		proofRequired: false,
		mutatesDesktop: false,
		mutatesFiles: false,
		rawSecretPossible: false,
	};
}

const DOMAIN_KEYS: ToolDomain[] = [
	"desktop",
	"file",
	"shell",
	"web",
	"mcp",
	"unknown",
];
const RISK_KEYS: ToolRiskClass[] = ["observe", "low", "medium", "high"];
const LANE_KEYS: ToolLane[] = [
	"desktop_observe",
	"desktop_action",
	"file_read",
	"file_edit",
	"shell_exec",
	"web_access",
	"mcp_meta",
	"unknown",
];

function zeroCounts<const Key extends string>(
	keys: readonly Key[],
): Record<Key, number> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
}

export function summarizeToolCapabilities(
	capabilities: readonly ToolCapabilityMetadata[],
): ToolCapabilitySummary {
	const byDomain = zeroCounts(DOMAIN_KEYS);
	const byRiskClass = zeroCounts(RISK_KEYS);
	const byToolLane = zeroCounts(LANE_KEYS);
	let mutatingDesktop = 0;
	let mutatingFiles = 0;
	let requiresReceipt = 0;
	let rawSecretPossible = 0;

	for (const capability of capabilities) {
		byDomain[capability.domain] += 1;
		byRiskClass[capability.riskClass] += 1;
		byToolLane[capability.toolLane] += 1;
		if (capability.mutatesDesktop) {
			mutatingDesktop += 1;
		}
		if (capability.mutatesFiles) {
			mutatingFiles += 1;
		}
		if (capability.requiresReceipt) {
			requiresReceipt += 1;
		}
		if (capability.rawSecretPossible) {
			rawSecretPossible += 1;
		}
	}

	return {
		total: capabilities.length,
		byDomain,
		byRiskClass,
		byToolLane,
		mutating: {
			desktop: mutatingDesktop,
			files: mutatingFiles,
		},
		requiresReceipt,
		rawSecretPossible,
	};
}
