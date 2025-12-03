import type {
	ParseError,
	ParseErrorCode,
	ParseOptions,
} from "jsonc-parser";

export const parseJsonc: (
	text: string,
	errors?: ParseError[],
	options?: ParseOptions,
) => unknown;
export const printParseErrorCode: (code: ParseErrorCode) => string;
