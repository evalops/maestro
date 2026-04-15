export type PromptResolutionSource = "bundled" | "service" | "override";

export interface PromptMetadata {
	name: string;
	label: string;
	surface?: string;
	version?: number;
	versionId?: string;
	hash: string;
	source: PromptResolutionSource;
}

export interface ResolvePromptTemplateInput {
	name: string;
	label?: string;
	surface?: string;
}

export interface ResolvedPromptTemplate {
	name: string;
	label: string;
	surface?: string;
	version: number;
	versionId: string;
	content: string;
}

export interface ResolvedSystemPrompt {
	systemPrompt: string;
	promptMetadata: PromptMetadata;
}
