export interface ParsedKeyValueTokens {
	values?: Record<string, string>;
	error?: string;
}

export function parseKeyValueTokens(
	tokens: readonly string[],
	errorMessage: string,
): ParsedKeyValueTokens {
	const values: Record<string, string> = {};

	for (const token of tokens) {
		const separatorIndex = token.indexOf("=");
		if (separatorIndex <= 0) {
			return { error: errorMessage };
		}

		const key = token.slice(0, separatorIndex).trim();
		if (!key) {
			return { error: errorMessage };
		}

		values[key] = token.slice(separatorIndex + 1);
	}

	return {
		values: Object.keys(values).length > 0 ? values : undefined,
	};
}
