import { createHash } from "node:crypto";
import type { RuntimeConstraintContext } from "@evalops/contracts";
import {
	buildBundledSystemPromptBase,
	finalizeSystemPrompt,
	resolveSystemPromptOverride,
} from "../cli/system-prompt.js";
import { loadPromptProjectDocManifest } from "../config/index.js";
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
	runtimeConstraints?: RuntimeConstraintContext | null;
	cwd?: string;
}): Promise<ResolvedSystemPrompt> {
	const cwd = options?.cwd ?? process.cwd();
	const promptContextManifest = loadPromptProjectDocManifest(cwd);
	const finalizeOptions = {
		runtimeConstraints: options?.runtimeConstraints,
		promptContextManifest,
	};
	const overridePrompt = resolveSystemPromptOverride(options?.customPrompt);
	if (overridePrompt) {
		return {
			systemPrompt: finalizeSystemPrompt(
				overridePrompt,
				options?.appendPrompt,
				cwd,
				finalizeOptions,
			),
			promptMetadata: buildPromptMetadata(overridePrompt, {
				source: "override",
			}),
			promptContextManifest,
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
				cwd,
				finalizeOptions,
			),
			promptMetadata: buildPromptMetadata(resolvedPrompt.content, {
				source: "service",
				version: resolvedPrompt.version,
				versionId: resolvedPrompt.versionId,
			}),
			promptContextManifest,
		};
	}

	const bundledPrompt = buildBundledSystemPromptBase(options?.toolNames);
	return {
		systemPrompt: finalizeSystemPrompt(
			bundledPrompt,
			options?.appendPrompt,
			cwd,
			finalizeOptions,
		),
		promptMetadata: buildPromptMetadata(bundledPrompt, {
			source: "bundled",
		}),
		promptContextManifest,
	};
}
