// Runtime helper: use jsonc-parser UMD build to avoid missing ESM subpaths in CI.
import * as jsoncUmd from "jsonc-parser/lib/umd/jsonc-parser.js";

export const parseJsonc = jsoncUmd.parse;
export const printParseErrorCode = jsoncUmd.printParseErrorCode;
