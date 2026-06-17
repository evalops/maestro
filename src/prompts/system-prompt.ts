import { createHash } from "node:crypto";
import type { RuntimeConstraintContext } from "@evalops/contracts";
import {
	buildBundledSystemPromptBase,
	finalizeSystemPrompt,
	resolveExplicitSystemPromptSourcePaths,
	resolveSystemPromptOverride,
} from "../cli/system-prompt.js";
import type { ComposerConfig } from "../config/index.js";
import {
	loadPromptProjectDocManifest,
	resolveLoadedAppendSystemPromptPath,
} from "../config/index.js";
import { hasPromptServiceBaseUrlSignal } from "./service-signal.js";
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

interface ResolveMaestroSystemPromptOptions {
	customPrompt?: string;
	toolNames?: string[];
	appendPrompt?: string;
	runtimeConstraints?: RuntimeConstraintContext | null;
	cwd?: string;
	profileName?: string;
	cliOverrides?: Partial<ComposerConfig>;
}

function resolveSystemPromptSourcePaths(
	cwd: string,
	options?: ResolveMaestroSystemPromptOptions,
): string[] {
	const explicitSourcePaths = resolveExplicitSystemPromptSourcePaths(
		options?.customPrompt,
		options?.appendPrompt,
	);
	const appendPromptOverride = resolveSystemPromptOverride(
		options?.appendPrompt,
	);
	const loadedAppendSystemPromptPath = appendPromptOverride
		? null
		: resolveLoadedAppendSystemPromptPath(
				cwd,
				options?.profileName,
				options?.cliOverrides,
			);
	return [
		...new Set(
			[...explicitSourcePaths, loadedAppendSystemPromptPath].filter(
				(value): value is string => typeof value === "string",
			),
		),
	];
}

export async function resolveMaestroSystemPrompt(
	options?: ResolveMaestroSystemPromptOptions,
): Promise<ResolvedSystemPrompt> {
	const cwd = options?.cwd ?? process.cwd();
	const promptContextManifest = loadPromptProjectDocManifest(cwd);
	const systemPromptSourcePaths = resolveSystemPromptSourcePaths(cwd, options);
	const finalizeOptions = {
		runtimeConstraints: options?.runtimeConstraints,
		promptContextManifest,
		profileName: options?.profileName,
		cliOverrides: options?.cliOverrides,
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
			systemPromptSourcePaths,
		};
	}

	const resolvedPrompt = hasPromptServiceBaseUrlSignal()
		? await import("./service-client.js").then(({ resolvePromptTemplate }) =>
				resolvePromptTemplate({
					name: DEFAULT_PROMPT_NAME,
					label: DEFAULT_PROMPT_LABEL,
					surface: DEFAULT_PROMPT_SURFACE,
				}),
			)
		: null;
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
			systemPromptSourcePaths,
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
		systemPromptSourcePaths,
	};
}
