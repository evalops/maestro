import chalk from "chalk";
import {
	type AgentMode,
	type ModelProvider,
	type ResolvedSubagentDispatch,
	getAllModes,
	getModeConfig,
	getModelForMode,
	getModelForTier,
	parseMode,
	resolveSubagentDispatch,
} from "../../agent/modes.js";
import {
	SUBAGENT_SPECS,
	type SubagentType,
} from "../../agent/subagent-specs.js";
import { recordStagedRolloutSurfaceUsage } from "../../telemetry.js";

const PROVIDERS: ModelProvider[] = [
	"anthropic",
	"openai",
	"openai-codex",
	"google",
];

type ModeCommandOptions = {
	provider?: string;
	json?: boolean;
	includeHidden?: boolean;
};

type ModeDescription = {
	mode: AgentMode;
	displayName: string;
	description: string;
	visible: boolean;
	primary: {
		tier: string;
		provider: ModelProvider;
		model: string;
	};
	fallback: {
		tier: string;
		provider: ModelProvider;
		model: string;
	};
	reasoningEffort: string;
	thinking: {
		enabled: boolean;
		budget: number;
	};
	context: {
		extended: boolean;
	};
	retries: number;
	costMultiplier: number;
	speedHint: number;
	subagents: Array<
		ResolvedSubagentDispatch & {
			displayName: string;
			description: string;
		}
	>;
};

function parseProvider(provider: string | undefined): ModelProvider {
	if (!provider) {
		return "anthropic";
	}
	if (PROVIDERS.includes(provider as ModelProvider)) {
		return provider as ModelProvider;
	}
	throw new Error(
		`Unknown provider "${provider}". Supported providers: ${PROVIDERS.join(", ")}`,
	);
}

function allSubagentTypes(): SubagentType[] {
	return Object.keys(SUBAGENT_SPECS) as SubagentType[];
}

function buildModeDescription(
	mode: AgentMode,
	provider: ModelProvider,
): ModeDescription {
	const config = getModeConfig(mode);
	return {
		mode,
		displayName: config.displayName,
		description: config.description,
		visible: config.visible,
		primary: {
			tier: config.primaryTier,
			provider,
			model: getModelForMode(mode, provider),
		},
		fallback: {
			tier: config.fallbackTier,
			provider,
			model: getModelForTier(config.fallbackTier, provider),
		},
		reasoningEffort:
			config.reasoningEffort ?? (config.enableThinking ? "medium" : "low"),
		thinking: {
			enabled: config.enableThinking,
			budget: config.thinkingBudget,
		},
		context: {
			extended: config.useExtendedContext,
		},
		retries: config.maxRetries,
		costMultiplier: config.costMultiplier,
		speedHint: config.speedHint,
		subagents: allSubagentTypes().map((type) => {
			const dispatch = resolveSubagentDispatch(mode, type, provider);
			const spec = SUBAGENT_SPECS[type];
			return {
				...dispatch,
				displayName: spec.displayName,
				description: spec.description,
			};
		}),
	};
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value.padEnd(width);
}

function renderModeDescription(description: ModeDescription): string {
	const visibility = description.visible ? "visible" : "hidden";
	const lines = [
		`Mode: ${description.displayName} (${description.mode})`,
		description.description,
		"",
		`Visibility: ${visibility}`,
		`Primary: ${description.primary.tier} -> ${description.primary.provider}/${description.primary.model}`,
		`Fallback: ${description.fallback.tier} -> ${description.fallback.provider}/${description.fallback.model}`,
		`Reasoning: ${description.reasoningEffort}`,
		`Thinking: ${description.thinking.enabled ? "enabled" : "disabled"} (budget ${description.thinking.budget})`,
		`Context: ${description.context.extended ? "extended" : "standard"}`,
		`Retries: ${description.retries}`,
		"",
		`Subagent dispatch (provider: ${description.primary.provider})`,
		`${pad("Type", 12)} ${pad("Source", 8)} ${pad("Provider", 14)} ${pad("Model", 34)} ${pad("Effort", 8)} Tier`,
		`${"-".repeat(12)} ${"-".repeat(8)} ${"-".repeat(14)} ${"-".repeat(34)} ${"-".repeat(8)} ${"-".repeat(8)}`,
	];

	for (const dispatch of description.subagents) {
		lines.push(
			[
				pad(dispatch.type, 12),
				pad(dispatch.source, 8),
				pad(dispatch.provider, 14),
				pad(dispatch.model, 34),
				pad(dispatch.reasoningEffort, 8),
				dispatch.modelTier ?? "-",
			].join(" "),
		);
	}

	return lines.join("\n");
}

function renderModesList(includeHidden: boolean): string {
	const lines = ["Agent modes:", ""];
	for (const { mode, config } of getAllModes({ includeHidden })) {
		const hiddenSuffix = config.visible === false ? " [hidden]" : "";
		lines.push(`${mode}${hiddenSuffix}`);
		lines.push(`  ${config.description}`);
		lines.push(`  describe: maestro modes describe ${mode}`);
	}
	return lines.join("\n");
}

function usage(): string {
	return [
		"Usage:",
		"  maestro modes list",
		"  maestro modes describe <mode> [--provider <provider>] [--json]",
		"",
		"Examples:",
		"  maestro modes describe smart",
		"  maestro modes describe frontier --provider openai --json",
	].join("\n");
}

export async function handleModesCommand(
	subcommand: string | undefined,
	messages: string[] = [],
	options: ModeCommandOptions = {},
): Promise<void> {
	const provider = parseProvider(options.provider);
	const command = subcommand ?? "list";

	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}

	if (command === "list") {
		console.log(renderModesList(options.includeHidden === true));
		return;
	}

	const modeName = command === "describe" ? messages[0] : command;
	const mode = modeName ? parseMode(modeName) : null;
	if (!mode) {
		const suffix = modeName ? `: ${modeName}` : "";
		console.error(chalk.red(`Unknown mode${suffix}`));
		console.log(chalk.dim(usage()));
		process.exit(1);
	}

	const description = buildModeDescription(mode, provider);
	if (!description.visible) {
		const config = getModeConfig(mode);
		await recordStagedRolloutSurfaceUsage("hidden_mode_used", {
			surfaceId: `mode:${mode}`,
			surfaceType: "mode",
			owner: config.rolloutOwner,
			source: "cli:modes:describe",
		});
	}

	if (options.json) {
		console.log(JSON.stringify(description, null, 2));
		return;
	}

	console.log(renderModeDescription(description));
}
