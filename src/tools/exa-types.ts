export interface ExaSearchResult {
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	text?: string;
	summary?: string;
	highlights?: string[];
}

export interface ExaSearchResponse {
	requestId: string;
	results: ExaSearchResult[];
	resolvedSearchType?: string;
	context?: string;
	costDollars?: {
		total?: number;
		[key: string]: number | undefined;
	};
}

export interface ExaContextResponse {
	requestId: string;
	query: string;
	response: string;
	resultsCount: number;
	costDollars: string;
	searchTime: number;
	outputTokens: number;
}

export interface ExaContentsResult {
	id: string;
	url: string;
	title?: string;
	text?: string;
	summary?: string;
	highlights?: string[];
}

export interface ExaContentsResponse {
	results: ExaContentsResult[];
	statuses?: Array<{
		id: string;
		status: "success" | "error";
		error?: {
			tag: string;
			httpStatusCode: number;
		};
	}>;
}
