import {
	type ParseError,
	type ParseErrorCode,
	type ParseOptions,
	parse as parseJsonc,
	printParseErrorCode,
} from "jsonc-parser";

export { parseJsonc, printParseErrorCode };
export type { ParseError, ParseOptions, ParseErrorCode };
