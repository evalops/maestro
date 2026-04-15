import {
	applyRemoteAutoMemoryConsolidation,
	recallRemoteDurableMemories,
	upsertRemoteDurableMemory,
} from "./service-client.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

export interface DurableMemoryUpsertResult {
	entry: MemoryEntry;
	created: boolean;
	updated: boolean;
}

export interface DurableMemoryConsolidationResult {
	removed: number;
	added: number;
	updated: number;
}

export interface DurableMemoryConsolidationParams {
	options?: {
		cwd?: string;
		projectId?: string;
		projectName?: string;
	};
	removeEntries: MemoryEntry[];
	upserts: Array<{
		content: string;
		tags?: string[];
		topic: string;
	}>;
}

export interface DurableMemoryBackend {
	upsertDurableMemory(
		topic: string,
		content: string,
		options?: {
			cwd?: string;
			projectId?: string;
			projectName?: string;
			tags?: string[];
		},
	): Promise<DurableMemoryUpsertResult | null>;
	recallDurableMemories(
		query: string,
		options?: {
			cwd?: string;
			limit?: number;
		},
	): Promise<MemorySearchResult[] | null>;
	applyAutoMemoryConsolidation(
		params: DurableMemoryConsolidationParams,
	): Promise<DurableMemoryConsolidationResult | null>;
}

class ServiceClientDurableMemoryBackend implements DurableMemoryBackend {
	upsertDurableMemory(
		topic: string,
		content: string,
		options?: {
			cwd?: string;
			projectId?: string;
			projectName?: string;
			tags?: string[];
		},
	): Promise<DurableMemoryUpsertResult | null> {
		return upsertRemoteDurableMemory(topic, content, options);
	}

	recallDurableMemories(
		query: string,
		options?: {
			cwd?: string;
			limit?: number;
		},
	): Promise<MemorySearchResult[] | null> {
		return recallRemoteDurableMemories(query, options);
	}

	applyAutoMemoryConsolidation(
		params: DurableMemoryConsolidationParams,
	): Promise<DurableMemoryConsolidationResult | null> {
		return applyRemoteAutoMemoryConsolidation(params);
	}
}

const defaultDurableMemoryBackend = new ServiceClientDurableMemoryBackend();

export function getDurableMemoryBackend(): DurableMemoryBackend {
	return defaultDurableMemoryBackend;
}
