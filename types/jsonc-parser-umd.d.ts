declare module "jsonc-parser/lib/umd/jsonc-parser.js" {
	export * from "jsonc-parser";
	// Re-export specific symbols to keep type-checking intact.
	export {
		parse,
		parseTree,
		type ParseError,
		type ParseOptions,
		type ParseErrorCode,
		printParseErrorCode,
	} from "jsonc-parser";
}
