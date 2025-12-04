/**
 * Bash Safety Analyzer
 *
 * Aggregates bash parsing and dangerous pattern detection behind a single module.
 * This is an initial scaffold for issue #292 to consolidate safety helpers without
 * changing current behavior. It simply re-exports the existing implementations.
 */

export {
	analyzeCommandSafety,
	isKnownSafeCommand,
	isParserAvailable,
	parseBashCommand,
	unwrapShellCommand,
} from "./bash-parser.js";

export type { BashParseResult } from "./bash-parser.js";

export {
	dangerousPatternDescriptions,
	dangerousPatterns,
} from "./dangerous-patterns.js";
