export interface SearchToolAliases {
	webSearch: string[];
	codeSearch: string[];
	fetch: string[];
}

const DEFAULT_SEARCH_TOOL_ALIASES: SearchToolAliases = {
	webSearch: ["websearch"],
	codeSearch: ["codesearch"],
	fetch: ["webfetch"],
};

export function buildSearchGuidelines(
	toolNames: Set<string>,
	currentYear: number,
	aliases: Partial<SearchToolAliases> = {},
): string[] {
	const resolved: SearchToolAliases = {
		webSearch: aliases.webSearch ?? DEFAULT_SEARCH_TOOL_ALIASES.webSearch,
		codeSearch: aliases.codeSearch ?? DEFAULT_SEARCH_TOOL_ALIASES.codeSearch,
		fetch: aliases.fetch ?? DEFAULT_SEARCH_TOOL_ALIASES.fetch,
	};

	const availableWeb = resolved.webSearch.filter((name) => toolNames.has(name));
	const availableCode = resolved.codeSearch.filter((name) =>
		toolNames.has(name),
	);
	const availableFetch = resolved.fetch.filter((name) => toolNames.has(name));
	const guidelines: string[] = [];

	if (availableCode.length > 0) {
		const codeLabel = availableCode.join("/");
		guidelines.push(
			`**Use ${codeLabel} FIRST for programming questions**: Before searching local files for examples, use ${codeLabel} to find working code from billions of GitHub repos and documentation`,
		);
	}

	if (
		availableWeb.length > 0 ||
		availableCode.length > 0 ||
		availableFetch.length > 0
	) {
		const parts: string[] = [];
		if (availableWeb.length > 0) {
			parts.push(`${availableWeb.join(", ")} for current events/news/research`);
		}
		if (availableCode.length > 0) {
			parts.push(`${availableCode.join(", ")} for programming examples/docs`);
		}
		if (availableFetch.length > 0) {
			parts.push(`${availableFetch.join(", ")} when you have specific URLs`);
		}
		guidelines.push(
			`**Use web tools for external information**: ${parts.join("; ")}`,
		);
	}

	if (availableWeb.length > 0 || availableCode.length > 0) {
		const searchLabel = [...availableWeb, ...availableCode].join("/");
		guidelines.push(
			`When using ${searchLabel} for up-to-date information, include the current year (${currentYear}) in the query unless the user specifies a different year or a historical range`,
		);
	}

	return guidelines;
}
