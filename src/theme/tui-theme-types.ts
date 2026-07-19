/**
 * Structural theme contracts for terminal UI components.
 *
 * Defined here (rather than imported from the terminal UI package) so theme
 * helpers and non-TUI consumers can type-check without a hard dependency on
 * the interactive terminal UI package. Shapes match the package interfaces
 * so values remain structurally assignable at call sites inside the TUI.
 */

/** Theme functions for markdown elements (ANSI-styled strings). */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
}

/** Theme functions for selection lists. */
export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

/** Theme functions for the multiline editor. */
export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}
