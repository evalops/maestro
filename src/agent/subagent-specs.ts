/**
 * Subagent Tool Specifications
 *
 * Defines different subagent types and what tools they have access to.
 * This enables fine-grained control over capabilities for different agent contexts:
 * - explorer: Read-only exploration of codebase
 * - planner: Can read and use todo, but no file modifications
 * - coder: Full coding capabilities
 * - reviewer: Read-only with web access for reviewing code
 * - researcher: Web search and fetch focused
 * - browser-qa: Browser-based product QA with screenshots and repro evidence
 *
 * Inspired by Amp's subagentSpec/subagentType system.
 */

import { codexSubagentLaneForType } from "../codex/subagent-dispatch-table.js";
import { createLogger } from "../utils/logger.js";
import { normalizeToolNameForSafety } from "../utils/safety-normalization.js";

const logger = createLogger("agent:subagent-specs");

/**
 * Available subagent types.
 */
export type SubagentType =
	| "explorer"
	| "planner"
	| "coder"
	| "reviewer"
	| "test-runner"
	| "researcher"
	| "browser-qa"
	| "minimal"
	| "custom";

const CODEX_LANE_SUBAGENT_TYPES: Record<string, SubagentType> = {
	"code-writer": "coder",
	"code-review": "reviewer",
	"test-runner": "test-runner",
	"browser-qa": "browser-qa",
	"repo-explorer": "explorer",
	"release-shepherd": "coder",
};

/**
 * Tool categories for easier specification.
 */
export const TOOL_CATEGORIES = {
	/** Read-only file system tools */
	read: [
		"read",
		"list",
		"find",
		"search",
		"parallel_ripgrep",
		"diff",
		"status",
	],
	/** File modification tools */
	write: ["apply_patch", "edit", "write", "notebook_edit"],
	/** Shell execution */
	shell: ["bash", "background_tasks"],
	/** Web and external tools */
	web: ["websearch", "webfetch", "codesearch"],
	/** Browser/product QA tools */
	browser: [
		"agent_browser",
		"browser_open",
		"browser_snapshot",
		"browser_click",
		"browser_fill",
		"browser_type",
		"browser_screenshot",
		"browser_console",
		"browser_record",
		"read_page",
		"search_page",
		"find_on_page",
		"extract_links",
		"wait_for_selector",
		"click_element",
		"type_text",
		"scroll_page",
		"select_element",
		"navigate_to",
		"open_links_in_tabs",
		"highlight_element",
		"browser_operator",
		"mouse_action",
		"pointer_action",
		"keyboard_action",
		"extract_table_data",
		"capture_network",
		"capture_console_errors",
		"collect_diagnostics",
		"extract_document",
		"capture_screenshot",
		"native_click",
		"native_type",
		"native_press",
		"native_key_down",
		"native_key_up",
	],
	/** Interactive tools */
	interactive: ["ask_user", "todo"],
	/** GitHub tools */
	github: ["gh_pr", "gh_issue", "gh_repo"],
	/** Advanced tools */
	advanced: ["oracle"],
} as const;

/**
 * Get all tool names from categories.
 */
function toolsFromCategories(
	...categories: (keyof typeof TOOL_CATEGORIES)[]
): string[] {
	const tools: string[] = [];
	for (const cat of categories) {
		tools.push(...TOOL_CATEGORIES[cat]);
	}
	return [...new Set(tools)];
}

/**
 * Subagent specification defining capabilities.
 */
export interface SubagentSpec {
	/** Display name */
	displayName: string;
	/** Description of what this subagent is for */
	description: string;
	/** Tools that are allowed (whitelist) */
	allowedTools: string[];
	/** Tools that are explicitly denied (takes precedence) */
	deniedTools?: string[];
	/** Whether MCP servers can provide additional tools */
	allowMcp: boolean;
	/** Whether toolbox tools are allowed */
	allowToolbox: boolean;
	/** Maximum number of tool calls per turn */
	maxToolCallsPerTurn?: number;
	/** Whether dangerous operations require extra confirmation */
	requireConfirmation?: boolean;
}

/**
 * Default subagent specifications.
 */
export const SUBAGENT_SPECS: Record<SubagentType, SubagentSpec> = {
	explorer: {
		displayName: "Explorer",
		description: "Read-only codebase exploration - can search and read files",
		allowedTools: toolsFromCategories("read", "advanced"),
		deniedTools: ["oracle"], // Explorers shouldn't invoke oracle
		allowMcp: false,
		allowToolbox: false,
		maxToolCallsPerTurn: 20,
		requireConfirmation: false,
	},
	planner: {
		displayName: "Planner",
		description: "Planning mode - can read files and manage todos",
		allowedTools: [...toolsFromCategories("read", "interactive")],
		allowMcp: false,
		allowToolbox: false,
		maxToolCallsPerTurn: 15,
		requireConfirmation: false,
	},
	coder: {
		displayName: "Coder",
		description: "Full coding capabilities - can read, write, and execute",
		allowedTools: toolsFromCategories(
			"read",
			"write",
			"shell",
			"interactive",
			"github",
			"advanced",
		),
		allowMcp: true,
		allowToolbox: true,
		maxToolCallsPerTurn: 30,
		requireConfirmation: true,
	},
	reviewer: {
		displayName: "Reviewer",
		description: "Code review mode - can read files and search web",
		allowedTools: [...toolsFromCategories("read", "web"), "ask_user"],
		allowMcp: false,
		allowToolbox: false,
		maxToolCallsPerTurn: 15,
		requireConfirmation: false,
	},
	"test-runner": {
		displayName: "Test Runner",
		description: "Test execution mode - can run checks and inspect results",
		allowedTools: [
			...toolsFromCategories("read", "shell", "interactive"),
			"webfetch",
		],
		allowMcp: false,
		allowToolbox: false,
		maxToolCallsPerTurn: 20,
		requireConfirmation: false,
	},
	researcher: {
		displayName: "Researcher",
		description: "Research mode - focused on web search and analysis",
		allowedTools: [...toolsFromCategories("web", "read"), "ask_user", "todo"],
		allowMcp: true,
		allowToolbox: false,
		maxToolCallsPerTurn: 20,
		requireConfirmation: false,
	},
	"browser-qa": {
		displayName: "Browser QA",
		description:
			"Product QA mode - explores web surfaces and captures repro evidence",
		allowedTools: [
			...toolsFromCategories("read", "web", "browser"),
			"bash",
			"ask_user",
			"todo",
		],
		allowMcp: true,
		allowToolbox: true,
		maxToolCallsPerTurn: 25,
		requireConfirmation: false,
	},
	minimal: {
		displayName: "Minimal",
		description: "Minimal capabilities - only basic read operations",
		allowedTools: ["read", "list", "search"],
		allowMcp: false,
		allowToolbox: false,
		maxToolCallsPerTurn: 10,
		requireConfirmation: false,
	},
	custom: {
		displayName: "Custom",
		description: "User-defined tool specification",
		allowedTools: toolsFromCategories(
			"read",
			"write",
			"shell",
			"interactive",
			"advanced",
		),
		allowMcp: true,
		allowToolbox: true,
		requireConfirmation: true,
	},
};

/**
 * Get specification for a subagent type.
 */
export function getSubagentSpec(type: SubagentType): SubagentSpec {
	return SUBAGENT_SPECS[type];
}

/**
 * Check if a tool is allowed for a subagent type.
 */
export function isToolAllowed(
	toolName: string,
	type: SubagentType,
	customSpec?: Partial<SubagentSpec>,
): boolean {
	const spec = customSpec
		? { ...SUBAGENT_SPECS[type], ...customSpec }
		: SUBAGENT_SPECS[type];
	const normalizedToolName = normalizeToolNameForSafety(toolName);
	const deniedTools = spec.deniedTools?.map(normalizeToolNameForSafety) ?? [];
	const allowedTools = spec.allowedTools.map(normalizeToolNameForSafety);

	// Denied tools take precedence
	if (deniedTools.includes(normalizedToolName)) {
		return false;
	}

	// Check if in allowed list
	return allowedTools.includes(normalizedToolName);
}

/**
 * Get the list of allowed tools for a subagent type.
 */
export function getAllowedTools(
	type: SubagentType,
	customSpec?: Partial<SubagentSpec>,
): string[] {
	const spec = customSpec
		? { ...SUBAGENT_SPECS[type], ...customSpec }
		: SUBAGENT_SPECS[type];

	let tools = spec.allowedTools.map(normalizeToolNameForSafety);

	// Remove denied tools
	if (spec.deniedTools) {
		const deniedTools = new Set(
			spec.deniedTools.map(normalizeToolNameForSafety),
		);
		tools = tools.filter((t) => !deniedTools.has(t));
	}

	return [...new Set(tools)];
}

/**
 * Filter a list of tools based on subagent spec.
 */
export function filterToolsForSubagent<T extends { name: string }>(
	tools: T[],
	type: SubagentType,
	customSpec?: Partial<SubagentSpec>,
): T[] {
	const allowedTools = getAllowedTools(type, customSpec);

	return tools.filter((tool) => {
		const toolName = normalizeToolNameForSafety(tool.name);
		return allowedTools.includes(toolName);
	});
}

/**
 * Current subagent type for the session.
 */
let currentSubagentType: SubagentType = "coder";

/**
 * Get the current subagent type.
 */
export function getCurrentSubagentType(): SubagentType {
	return currentSubagentType;
}

/**
 * Set the current subagent type.
 */
export function setCurrentSubagentType(type: SubagentType): void {
	logger.info("Setting subagent type", { type });
	currentSubagentType = type;
}

/**
 * Parse subagent type from string.
 */
export function parseSubagentType(typeStr: string): SubagentType | null {
	const normalized = normalizeToolNameForSafety(typeStr);
	const hyphenated = normalized.replace(/_/g, "-");
	if (hyphenated in SUBAGENT_SPECS) {
		return hyphenated as SubagentType;
	}
	const lane = codexSubagentLaneForType(typeStr);
	return lane ? (CODEX_LANE_SUBAGENT_TYPES[lane.laneId] ?? null) : null;
}

/**
 * Get subagent type from environment variable.
 */
export function getSubagentTypeFromEnv(): SubagentType {
	return parseSubagentType(process.env.MAESTRO_SUBAGENT_TYPE ?? "") ?? "coder";
}

/**
 * Format subagent type for display.
 */
export function formatSubagentDisplay(type: SubagentType): string {
	const spec = getSubagentSpec(type);
	return `${spec.displayName} - ${spec.description}`;
}

/**
 * Get all available subagent types with their specs.
 */
export function getAllSubagentTypes(): Array<{
	type: SubagentType;
	spec: SubagentSpec;
}> {
	return (Object.entries(SUBAGENT_SPECS) as [SubagentType, SubagentSpec][]).map(
		([type, spec]) => ({
			type,
			spec,
		}),
	);
}

/**
 * Create a custom subagent spec by merging with a base type.
 */
export function createCustomSpec(
	baseType: SubagentType,
	overrides: Partial<SubagentSpec>,
): SubagentSpec {
	return {
		...SUBAGENT_SPECS[baseType],
		...overrides,
		displayName: overrides.displayName ?? "Custom",
		description: overrides.description ?? "Custom configuration",
	};
}

/**
 * Validate a subagent spec.
 */
export function validateSpec(spec: Partial<SubagentSpec>): string[] {
	const errors: string[] = [];

	if (spec.allowedTools && spec.allowedTools.length === 0) {
		errors.push("allowedTools cannot be empty");
	}

	if (spec.maxToolCallsPerTurn !== undefined && spec.maxToolCallsPerTurn < 1) {
		errors.push("maxToolCallsPerTurn must be at least 1");
	}

	return errors;
}
