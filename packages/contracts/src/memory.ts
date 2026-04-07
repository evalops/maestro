export interface MemoryEntry {
	id: string;
	topic: string;
	content: string;
	tags?: string[];
	sessionId?: string;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryTopicSummary {
	name: string;
	entryCount: number;
	lastUpdated: number;
}

export interface MemoryStats {
	totalEntries: number;
	topics: number;
	oldestEntry: number | null;
	newestEntry: number | null;
}

export interface MemorySearchResult {
	entry: MemoryEntry;
	score: number;
	matchedOn: string;
}

export interface MemoryTopicsResponse {
	topics: MemoryTopicSummary[];
}

export interface MemoryTopicResponse {
	topic: string;
	memories: MemoryEntry[];
}

export interface MemorySearchResponse {
	query: string;
	results: MemorySearchResult[];
}

export interface MemoryRecentResponse {
	memories: MemoryEntry[];
}

export interface MemoryStatsResponse {
	stats: MemoryStats;
}

export interface MemoryMutationResponse {
	success: boolean;
	message: string;
	entry?: MemoryEntry;
	count?: number;
	path?: string;
	result?: {
		added: number;
		updated: number;
		skipped: number;
	};
}
