/**
 * IPC Protocol types for communication with the Rust TUI binary.
 * Must match packages/tui-rs/src/protocol/
 */

// ============================================================================
// Inbound Messages (TypeScript → Rust)
// ============================================================================

export type InboundMessage =
	| RenderMessage
	| PushHistoryMessage
	| ResizeMessage
	| ExitMessage
	| NotifyMessage;

export interface RenderMessage {
	type: "render";
	root: RenderNode;
	cursor: CursorPosition | null;
}

export interface PushHistoryMessage {
	type: "push_history";
	lines: HistoryLine[];
}

export interface ResizeMessage {
	type: "resize";
	width: number;
	height: number;
}

export interface ExitMessage {
	type: "exit";
	code: number;
}

export interface NotifyMessage {
	type: "notify";
	message: string;
}

// ============================================================================
// Outbound Messages (Rust → TypeScript)
// ============================================================================

export type OutboundMessage =
	| ReadyMessage
	| KeyMessage
	| PasteMessage
	| ResizedMessage
	| FocusMessage
	| ExitingMessage
	| ErrorMessage;

export interface ReadyMessage {
	type: "ready";
	width: number;
	height: number;
	enhanced_keys: boolean;
}

export interface KeyMessage {
	type: "key";
	key: string;
	modifiers: KeyModifiers;
}

export interface PasteMessage {
	type: "paste";
	text: string;
}

export interface ResizedMessage {
	type: "resized";
	width: number;
	height: number;
}

export interface FocusMessage {
	type: "focus";
	focused: boolean;
}

export interface ExitingMessage {
	type: "exiting";
	code: number;
}

export interface ErrorMessage {
	type: "error";
	message: string;
}

// ============================================================================
// Shared Types
// ============================================================================

export interface CursorPosition {
	x: number;
	y: number;
}

export interface KeyModifiers {
	shift?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	meta?: boolean;
}

export interface HistoryLine {
	spans: StyledSpan[];
}

export interface StyledSpan {
	text: string;
	style?: TextStyle;
}

export interface TextStyle {
	fg?: Color;
	bg?: Color;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
	strikethrough?: boolean;
}

export type Color = NamedColor | RgbColor | IndexedColor;

export type NamedColor =
	| "black"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "gray"
	| "dark_gray"
	| "light_red"
	| "light_green"
	| "light_yellow"
	| "light_blue"
	| "light_magenta"
	| "light_cyan"
	| "reset";

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export type IndexedColor = number;

// ============================================================================
// Render Tree Types
// ============================================================================

export type RenderNode =
	| TextNode
	| StyledTextNode
	| ColumnNode
	| RowNode
	| BoxNode
	| ScrollNode
	| InputNode
	| EditorNode
	| MarkdownNode
	| SelectListNode
	| StatusBarNode
	| SpacerNode
	| EmptyNode;

export interface TextNode {
	type: "text";
	content: string;
	style?: TextStyle;
}

export interface StyledTextNode {
	type: "styled_text";
	spans: StyledSpan[];
}

export interface ColumnNode {
	type: "column";
	children: RenderNode[];
	gap?: number;
}

export interface RowNode {
	type: "row";
	children: RenderNode[];
	gap?: number;
}

export interface BoxNode {
	type: "box";
	child?: RenderNode;
	border?: BorderStyle;
	padding?: Padding;
	title?: string;
}

export interface ScrollNode {
	type: "scroll";
	child: RenderNode;
	offset: number;
	content_height: number;
	show_scrollbar?: boolean;
}

export interface InputNode {
	type: "input";
	value: string;
	cursor: number;
	placeholder?: string;
	focused?: boolean;
}

export interface EditorNode {
	type: "editor";
	lines: string[];
	cursor: [number, number];
	focused?: boolean;
	scroll_offset?: number;
}

export interface MarkdownNode {
	type: "markdown";
	lines: StyledSpan[][];
}

export interface SelectListNode {
	type: "select_list";
	items: SelectItem[];
	selected: number;
	scroll_offset?: number;
}

export interface StatusBarNode {
	type: "status_bar";
	left: StatusItem[];
	center?: StatusItem[];
	right?: StatusItem[];
}

export interface SpacerNode {
	type: "spacer";
	size?: number;
}

export interface EmptyNode {
	type: "empty";
}

export type BorderStyle = "none" | "single" | "double" | "rounded" | "heavy";

export interface Padding {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export interface SelectItem {
	label: string;
	description?: string;
	hint?: string;
	disabled?: boolean;
}

export interface StatusItem {
	content: string;
	style?: TextStyle;
}
