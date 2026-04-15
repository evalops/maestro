import { createHash } from "node:crypto";
import {
	buildBundledSystemPromptBase,
	finalizeSystemPrompt,
	resolveSystemPromptOverride,
} from "../cli/system-prompt.js";
import { resolvePromptTemplate } from "./service-client.js";
import type { PromptMetadata, ResolvedSystemPrompt } from "./types.js";

const DEFAULT_PROMPT_NAME = "maestro-system";
const DEFAULT_PROMPT_LABEL = "production";
const DEFAULT_PROMPT_SURFACE = "maestro";

function hashPrompt(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function buildPromptMetadata(
	baseContent: string,
	options: {
		source: PromptMetadata["source"];
		version?: number;
		versionId?: string;
	},
): PromptMetadata {
	return {
		name: DEFAULT_PROMPT_NAME,
		label: DEFAULT_PROMPT_LABEL,
		surface: DEFAULT_PROMPT_SURFACE,
		version: options.version,
		versionId: options.versionId,
		hash: hashPrompt(baseContent),
		source: options.source,
	};
}

export async function resolveMaestroSystemPrompt(options?: {
	customPrompt?: string;
	toolNames?: string[];
	appendPrompt?: string;
}): Promise<ResolvedSystemPrompt> {
	const overridePrompt = resolveSystemPromptOverride(options?.customPrompt);
	if (overridePrompt) {
		return {
			systemPrompt: finalizeSystemPrompt(overridePrompt, options?.appendPrompt),
			promptMetadata: buildPromptMetadata(overridePrompt, {
				source: "override",
			}),
		};
	}

	const resolvedPrompt = await resolvePromptTemplate({
		name: DEFAULT_PROMPT_NAME,
		label: DEFAULT_PROMPT_LABEL,
		surface: DEFAULT_PROMPT_SURFACE,
	});
	if (resolvedPrompt) {
		return {
			systemPrompt: finalizeSystemPrompt(
				resolvedPrompt.content,
				options?.appendPrompt,
			),
			promptMetadata: buildPromptMetadata(resolvedPrompt.content, {
				source: "service",
				version: resolvedPrompt.version,
				versionId: resolvedPrompt.versionId,
			}),
		};
	}

	const bundledPrompt = buildBundledSystemPromptBase(options?.toolNames);
	return {
		systemPrompt: finalizeSystemPrompt(bundledPrompt, options?.appendPrompt),
		promptMetadata: buildPromptMetadata(bundledPrompt, {
			source: "bundled",
		}),
	};
}
