import { Type } from "@sinclair/typebox";
import type { AgentTool } from "../agent/types.js";

const anyArgsSchema = Type.Object({}, { additionalProperties: true });

const selectorSchema = Type.String({
	description: "CSS selector or XPath (xpath=...) targeting a page element",
});

const optionalSelectorSchema = Type.Optional(selectorSchema);

const commonTimeoutSchema = Type.Optional(
	Type.Number({ description: "Timeout in milliseconds" }),
);

// Core page interaction tools (client-side)
export const conductorReadPageTool: AgentTool = {
	name: "read_page",
	description:
		"Read the current page content (text, headings, links, optional forms/metadata).",
	parameters: Type.Object(
		{
			include_forms: Type.Optional(Type.Boolean()),
			include_meta: Type.Optional(Type.Boolean()),
			include_markdown: Type.Optional(Type.Boolean()),
			include_links: Type.Optional(Type.Boolean()),
			cache_control: Type.Optional(
				Type.Object(
					{
						strategy: Type.Optional(
							Type.Union([Type.Literal("default"), Type.Literal("refresh")]),
						),
					},
					{ additionalProperties: true },
				),
			),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorSearchPageTool: AgentTool = {
	name: "search_page",
	description:
		"Search the current page for text and return matching selectors and snippets.",
	parameters: Type.Object(
		{
			query: Type.String({ description: "Text or regex to search for" }),
			regex: Type.Optional(Type.Boolean()),
			whole_word: Type.Optional(Type.Boolean()),
			scope: optionalSelectorSchema,
			max_results: Type.Optional(Type.Number()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorFindOnPageTool: AgentTool = {
	name: "find_on_page",
	description:
		"Find content or navigation elements on the current page with advanced filtering.",
	parameters: Type.Object(
		{
			query: Type.String({ description: "Text or regex to search for" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("navigation")]),
			),
			regex: Type.Optional(Type.Boolean()),
			whole_word: Type.Optional(Type.Boolean()),
			scope: optionalSelectorSchema,
			max_results: Type.Optional(Type.Number()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorExtractLinksTool: AgentTool = {
	name: "extract_links",
	description:
		"Extract links/buttons from the page, optionally filtered by label or URL pattern.",
	parameters: Type.Object(
		{
			include: Type.Optional(
				Type.Object(
					{
						pattern: Type.Optional(Type.String()),
						label: Type.Optional(Type.String()),
					},
					{ additionalProperties: true },
				),
			),
			scope: optionalSelectorSchema,
			include_buttons: Type.Optional(Type.Boolean()),
			max_results: Type.Optional(Type.Number()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorWaitForSelectorTool: AgentTool = {
	name: "wait_for_selector",
	description:
		"Wait until a selector appears (optionally visible) before continuing.",
	parameters: Type.Object(
		{
			selector: selectorSchema,
			timeout_ms: commonTimeoutSchema,
			visible_only: Type.Optional(Type.Boolean()),
			scroll_into_view: Type.Optional(Type.Boolean()),
			align: Type.Optional(
				Type.Union([
					Type.Literal("start"),
					Type.Literal("center"),
					Type.Literal("end"),
					Type.Literal("nearest"),
				]),
			),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorClickElementTool: AgentTool = {
	name: "click_element",
	description: "Click a page element using a selector.",
	parameters: Type.Object(
		{
			selector: selectorSchema,
			action: Type.Optional(Type.String()),
			strategy: Type.Optional(Type.String()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorTypeTextTool: AgentTool = {
	name: "type_text",
	description: "Type text into an input, textarea, or contentEditable element.",
	parameters: Type.Object(
		{
			selector: selectorSchema,
			text: Type.String({ description: "Text to input" }),
			press_enter: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorScrollPageTool: AgentTool = {
	name: "scroll_page",
	description: "Scroll the page or a container by distance or to top/bottom.",
	parameters: Type.Object(
		{
			distance: Type.Optional(Type.Number()),
			direction: Type.Optional(
				Type.Union([Type.Literal("up"), Type.Literal("down")]),
			),
			target: Type.Optional(
				Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
			),
			selector: optionalSelectorSchema,
			iterations: Type.Optional(Type.Number()),
			delay_ms: Type.Optional(Type.Number()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorSelectElementTool: AgentTool = {
	name: "select_element",
	description:
		"Open a visual picker for the user to select an element. Returns robust selectors.",
	parameters: Type.Object(
		{
			purpose: Type.Optional(Type.String()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorNavigateToTool: AgentTool = {
	name: "navigate_to",
	description:
		"Navigate to a URL or manage tabs (list, switch, open, close, reload).",
	parameters: Type.Object(
		{
			action: Type.String({
				description:
					"Navigation action (goToUrl, listTabs, switchToTab, closeTab, reload, back, forward)",
			}),
			url: Type.Optional(Type.String()),
			tab_id: Type.Optional(Type.Number()),
			active: Type.Optional(Type.Boolean()),
			bypass_cache: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorOpenLinksInTabsTool: AgentTool = {
	name: "open_links_in_tabs",
	description: "Open multiple URLs in new tabs (optionally throttled).",
	parameters: Type.Object(
		{
			urls: Type.Array(Type.String()),
			background: Type.Optional(Type.Boolean()),
			delay_ms: Type.Optional(Type.Number()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorHighlightElementTool: AgentTool = {
	name: "highlight_element",
	description: "Highlight an element using the on-page overlay.",
	parameters: Type.Object(
		{
			selector: selectorSchema,
			note: Type.Optional(Type.String()),
			duration_ms: Type.Optional(Type.Number()),
			scroll_into_view: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorMouseActionTool: AgentTool = {
	name: "mouse_action",
	description:
		"Mouse actions (hover, double click, drag) using the debugger strategy.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorPointerActionTool: AgentTool = {
	name: "pointer_action",
	description:
		"Pointer actions (click, hover, drag) with DOM/debugger/native strategies.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorKeyboardActionTool: AgentTool = {
	name: "keyboard_action",
	description:
		"Keyboard actions (press keys, shortcuts) using debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorExtractTableDataTool: AgentTool = {
	name: "extract_table_data",
	description: "Extract tabular data from HTML tables or grid layouts.",
	parameters: Type.Object(
		{
			selector: optionalSelectorSchema,
			max_rows: Type.Optional(Type.Number()),
			include_hidden: Type.Optional(Type.Boolean()),
			preserve_formatting: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

// Observability/context tools
export const conductorCaptureNetworkTool: AgentTool = {
	name: "capture_network",
	description: "Capture network requests for the active tab.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorCaptureConsoleErrorsTool: AgentTool = {
	name: "capture_console_errors",
	description: "Capture console errors/warnings from the active tab.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorCollectDiagnosticsTool: AgentTool = {
	name: "collect_diagnostics",
	description: "Collect diagnostic info (tab/url/environment state).",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorExtractDocumentTool: AgentTool = {
	name: "extract_document",
	description: "Extract text from a document URL (PDF/DOCX/XLSX/etc).",
	parameters: Type.Object(
		{
			url: Type.String({ description: "Document URL" }),
			max_pages: Type.Optional(Type.Number()),
			per_page: Type.Optional(Type.Boolean()),
			password: Type.Optional(Type.String()),
			timeout_ms: commonTimeoutSchema,
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorCaptureScreenshotTool: AgentTool = {
	name: "capture_screenshot",
	description: "Capture a screenshot with scene graph metadata.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

// Advanced/native input tools
export const conductorNativeClickTool: AgentTool = {
	name: "native_click",
	description: "Trusted click using Chrome debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorNativeTypeTool: AgentTool = {
	name: "native_type",
	description: "Trusted text input using Chrome debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorNativePressTool: AgentTool = {
	name: "native_press",
	description: "Trusted key press using Chrome debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorNativeKeyDownTool: AgentTool = {
	name: "native_key_down",
	description: "Trusted key down using Chrome debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorNativeKeyUpTool: AgentTool = {
	name: "native_key_up",
	description: "Trusted key up using Chrome debugger protocol.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

// Skills + artifacts (optional, but supported by Conductor)
export const conductorRunSkillTool: AgentTool = {
	name: "run_skill",
	description: "Run a Conductor skill script by name.",
	parameters: Type.Object(
		{
			name: Type.String({ description: "Skill name" }),
			args: Type.Optional(Type.Record(Type.String(), Type.Any())),
			timeout_ms: commonTimeoutSchema,
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorManageArtifactTool: AgentTool = {
	name: "manage_artifact",
	description:
		"Create/update/delete Conductor artifacts in the current session.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorPatchArtifactTool: AgentTool = {
	name: "patch_artifact",
	description: "Apply a unified diff patch to a Conductor artifact.",
	parameters: anyArgsSchema,
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

// MCP helper tools (client-side)
export const conductorListMcpServersTool: AgentTool = {
	name: "list_mcp_servers",
	description: "List configured MCP servers.",
	parameters: Type.Object({}, { additionalProperties: true }),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorListMcpToolsTool: AgentTool = {
	name: "list_mcp_tools",
	description: "List tools exposed by connected MCP servers.",
	parameters: Type.Object(
		{ server: Type.Optional(Type.String()) },
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorListMcpResourcesTool: AgentTool = {
	name: "list_mcp_resources",
	description: "List resources exposed by connected MCP servers.",
	parameters: Type.Object(
		{
			server: Type.Optional(
				Type.String({
					description:
						"Optional MCP server name to filter resources. If omitted, lists resources from all connected servers.",
				}),
			),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorReadMcpResourceTool: AgentTool = {
	name: "read_mcp_resource",
	description: "Read a resource from an MCP server by URI.",
	parameters: Type.Object(
		{
			server: Type.String({ description: "MCP server name" }),
			uri: Type.String({ description: "Resource URI" }),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorListMcpPromptsTool: AgentTool = {
	name: "list_mcp_prompts",
	description: "List prompts exposed by connected MCP servers.",
	parameters: Type.Object(
		{ server: Type.Optional(Type.String()) },
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorGetMcpPromptTool: AgentTool = {
	name: "get_mcp_prompt",
	description: "Fetch an MCP prompt by server and prompt name.",
	parameters: Type.Object(
		{
			server: Type.String({ description: "MCP server name" }),
			name: Type.String({ description: "Prompt name" }),
			args: Type.Optional(Type.Record(Type.String(), Type.String())),
		},
		{ additionalProperties: true },
	),
	executionLocation: "client",
	execute: async () => ({ content: [], isError: false }),
};

export const conductorClientTools: AgentTool[] = [
	conductorReadPageTool,
	conductorSearchPageTool,
	conductorFindOnPageTool,
	conductorExtractLinksTool,
	conductorWaitForSelectorTool,
	conductorClickElementTool,
	conductorTypeTextTool,
	conductorScrollPageTool,
	conductorSelectElementTool,
	conductorNavigateToTool,
	conductorOpenLinksInTabsTool,
	conductorHighlightElementTool,
	conductorMouseActionTool,
	conductorPointerActionTool,
	conductorKeyboardActionTool,
	conductorExtractTableDataTool,
	conductorCaptureNetworkTool,
	conductorCaptureConsoleErrorsTool,
	conductorCollectDiagnosticsTool,
	conductorExtractDocumentTool,
	conductorCaptureScreenshotTool,
	conductorNativeClickTool,
	conductorNativeTypeTool,
	conductorNativePressTool,
	conductorNativeKeyDownTool,
	conductorNativeKeyUpTool,
	conductorRunSkillTool,
	conductorManageArtifactTool,
	conductorPatchArtifactTool,
	conductorListMcpServersTool,
	conductorListMcpToolsTool,
	conductorListMcpResourcesTool,
	conductorReadMcpResourceTool,
	conductorListMcpPromptsTool,
	conductorGetMcpPromptTool,
];
