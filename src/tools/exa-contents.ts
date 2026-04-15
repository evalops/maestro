import { Type } from "@sinclair/typebox";

export const ExaSummaryConfigSchema = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Hint the summary for a specific target (docs, news, finance, etc.)",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Override Exa summary model (e.g., exa:claude-3)",
		}),
	),
	includeQuotes: Type.Optional(
		Type.Boolean({
			description: "Include quoted sentences in the summary",
			default: false,
		}),
	),
});

export const ExaSummaryOptionSchema = Type.Union(
	[
		Type.Boolean({
			description: "Return AI-generated summary",
			default: false,
		}),
		ExaSummaryConfigSchema,
	],
	{
		description:
			"Return AI-generated summary (boolean) or customize via target/model",
	},
);

export const ExaHighlightsConfigSchema = Type.Object({
	numSentences: Type.Optional(
		Type.Integer({
			description: "Number of sentences per highlight",
			minimum: 1,
			maximum: 10,
			default: 3,
		}),
	),
	highlightsPerUrl: Type.Optional(
		Type.Integer({
			description: "Maximum highlights per URL",
			minimum: 1,
			maximum: 20,
			default: 5,
		}),
	),
});

export const ExaHighlightsOptionSchema = Type.Union(
	[
		Type.Boolean({
			description: "Return relevant highlights/excerpts",
		}),
		ExaHighlightsConfigSchema,
	],
	{
		description:
			"Control highlight extraction (boolean or config object with numSentences/highlightsPerUrl)",
	},
);

export const ExaTextOptionSchema = Type.Boolean({
	description: "Return full page text content in markdown format",
	default: true,
});

export const ExaContextOptionSchema = Type.Boolean({
	description:
		"Return LLM-optimized context string combining all results (recommended for RAG). Better than individual text for LLM consumption.",
	default: true,
});

type ContentsKey = "text" | "summary" | "context" | "highlights";
type ContentsValue = boolean | Record<string, unknown>;
export type ContentsOptionsMap<K extends ContentsKey> = Partial<
	Record<K, ContentsValue>
>;

export function buildContentsOptions<K extends ContentsKey>(
	options: ContentsOptionsMap<K>,
	defaults?: ContentsOptionsMap<K>,
): ContentsOptionsMap<K> | undefined {
	const defaultKeys = defaults ? (Object.keys(defaults) as ContentsKey[]) : [];
	const optionKeys = options ? (Object.keys(options) as ContentsKey[]) : [];
	const keys = new Set<ContentsKey>([...defaultKeys, ...optionKeys]);
	const result: Partial<Record<ContentsKey, ContentsValue>> = {};
	let hasValue = false;
	for (const key of keys) {
		const value =
			(options as Record<ContentsKey, ContentsValue | undefined>)[key] ??
			(
				defaults as Record<ContentsKey, ContentsValue | undefined> | undefined
			)?.[key];
		if (value !== undefined) {
			result[key] = value;
			hasValue = true;
		}
	}
	return hasValue ? (result as ContentsOptionsMap<K>) : undefined;
}
