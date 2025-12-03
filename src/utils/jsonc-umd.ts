import type { ParseError, ParseErrorCode, ParseOptions } from "jsonc-parser";
// Runtime helper: use jsonc-parser UMD main build to avoid missing ESM subpaths in CI.
// eslint-disable-next-line import/no-internal-modules
import * as jsoncUmd from "jsonc-parser/lib/umd/main.js";

export const parseJsonc = jsoncUmd.parse as (
	text: string,
	errors?: ParseError[],
	options?: ParseOptions,
) => unknown;

export const printParseErrorCode = jsoncUmd.printParseErrorCode as (
	code: ParseErrorCode,
) => string;

export type { ParseError, ParseOptions, ParseErrorCode };
