import { homedir } from "node:os";
import { Spacer, Text } from "@evalops/tui";
import type { Container, TUI } from "@evalops/tui";
import chalk from "chalk";
import type {
	ConfigInspection,
	ConfigValidationResult,
} from "../models/registry.js";
import {
	getConfigHierarchy,
	inspectConfig,
	validateConfig,
} from "../models/registry.js";
import { badge, muted, separator } from "../style/theme.js";
import type { CommandExecutionContext } from "./commands/types.js";

interface ConfigViewOptions {
	chatContainer: Container;
	ui: TUI;
	showError: (message: string) => void;
	showInfo?: (message: string) => void;
}

type ConfigSection =
	| "summary"
	| "validation"
	| "sources"
	| "providers"
	| "env"
	| "files";

export class ConfigView {
	constructor(private readonly options: ConfigViewOptions) {}

	showConfigSummary(): void {
		this.renderConfigReport("summary");
	}

	handleConfigCommand(
		context: CommandExecutionContext<{ section?: ConfigSection }>,
	): void {
		const tokens = context.argumentText
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		const fromParser = context.parsedArgs?.section;
		const action = tokens[0]?.toLowerCase();

		if (!action && !fromParser) {
			this.showConfigSummary();
			return;
		}

		if (fromParser) {
			this.renderConfigReport(fromParser);
			return;
		}

		if (!action || action === "show" || action === "summary") {
			this.showConfigSummary();
			return;
		}
		if (action === "sources" || action === "files") {
			this.showSourcesOnly();
			return;
		}
		if (action === "help") {
			this.renderHelp();
			return;
		}

		const section = this.toConfigSection(action);
		if (section) {
			this.renderConfigReport(section);
			return;
		}

		this.renderHelp();
		this.options.showInfo?.(
			`Unknown config option "${action}". Showing help instructions instead.`,
		);
	}

	private toConfigSection(value?: string): ConfigSection | undefined {
		if (!value) {
			return undefined;
		}
		switch (value) {
			case "summary":
			case "validation":
			case "sources":
			case "providers":
			case "env":
			case "files":
				return value;
			default:
				return undefined;
		}
	}

	private renderConfigReport(section: ConfigSection): void {
		try {
			const validation = validateConfig();
			const inspection = inspectConfig();
			const hierarchy = getConfigHierarchy();
			const sections = this.buildSections(validation, inspection, hierarchy);
			const content =
				sections[section] ??
				sections.summary ??
				chalk.dim("No data available.");
			const body =
				content.trim().length > 0
					? content
					: chalk.dim("No configuration details available.");
			this.render(body);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to inspect configuration";
			this.options.showError(`Config inspection failed: ${message}`);
		}
	}

	private buildSections(
		validation: ConfigValidationResult,
		inspection: ConfigInspection,
		hierarchy: string[],
	): Record<ConfigSection, string> {
		const validationSection = this.buildValidationSection(validation);
		const sourcesSection = this.buildSourcesSection(inspection, hierarchy);
		const providersSection = this.buildProvidersSection(inspection);
		const envSection = this.buildEnvSection(inspection);
		const filesSection = this.buildFileReferenceSection(inspection);
		const summaryParts = [
			chalk.bold("Composer configuration"),
			validationSection,
			sourcesSection,
			providersSection,
			envSection,
			filesSection,
		]
			.filter((part) => part && part.trim().length > 0)
			.join("\n\n");
		return {
			summary: summaryParts,
			validation: validationSection,
			sources: sourcesSection,
			providers: providersSection,
			env: envSection,
			files: filesSection,
		};
	}

	private render(text: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(text, 1, 0));
		this.options.ui.requestRender();
	}

	private buildValidationSection(result: ConfigValidationResult): string {
		const verdict = result.valid
			? badge("Validation", "ok", "success")
			: badge("Validation", "needs attention", "danger");
		const metrics = [
			badge("Config files", String(result.summary.configFiles.length)),
			badge("Providers", String(result.summary.providers)),
			badge("Models", String(result.summary.models)),
			badge("File refs", String(result.summary.fileReferences.length)),
			badge("Env vars", String(result.summary.envVars.length)),
		].join(separator());
		const errors = result.errors.length
			? `${badge("Errors", undefined, "danger")}\n${result.errors.map((error) => chalk.red(`  • ${error}`)).join("\n")}`
			: badge("Errors", "none", "success");
		const warnings = result.warnings.length
			? `${badge("Warnings", undefined, "warn")}\n${result.warnings.map((warning) => chalk.yellow(`  • ${warning}`)).join("\n")}`
			: badge("Warnings", "none", "info");
		return [verdict, metrics, errors, warnings].join("\n");
	}

	private buildSourcesSection(
		inspection: ConfigInspection,
		hierarchy: string[],
	): string {
		if (inspection.sources.length === 0) {
			return "";
		}
		const lines = inspection.sources.map((source) => {
			const rel = source.path.replace(homedir(), "~");
			const status = source.exists
				? badge(source.loaded ? "loaded" : "present", undefined, "success")
				: badge("missing", undefined, "warn");
			const mark = hierarchy.includes(source.path) ? "•" : " ";
			return `  ${mark} ${status} ${muted(rel)}`;
		});
		return `${badge("Config sources", undefined, "info")}\n${lines.join("\n")}`;
	}

	private buildProvidersSection(inspection: ConfigInspection): string {
		if (inspection.providers.length === 0) {
			return badge("Providers", "none configured", "warn");
		}
		const sections = inspection.providers.map((provider) => {
			const header = `${chalk.bold(provider.name)} ${muted(`(${provider.id})`)}`;
			const metaParts = [badge("Models", String(provider.modelCount))];
			if (provider.apiKeySource) {
				metaParts.push(badge("API key", provider.apiKeySource, "success"));
			} else if (provider.isLocal) {
				metaParts.push(badge("No API key", "local", "info"));
			} else {
				metaParts.push(badge("API key missing", undefined, "warn"));
			}
			if (provider.isLocal) {
				metaParts.push(badge("local", undefined, "warn"));
			}
			const meta = metaParts.join(separator());
			const baseUrlLine = muted(`Base URL: ${provider.baseUrl}`);
			const modelsToShow = provider.models.slice(0, 3);
			const modelLines = modelsToShow.map((model) =>
				muted(`   • ${model.id}${model.name ? ` — ${model.name}` : ""}`),
			);
			if (provider.models.length > modelsToShow.length) {
				modelLines.push(
					muted(
						`   • … and ${provider.models.length - modelsToShow.length} more`,
					),
				);
			}
			return [header, `  ${meta}`, `  ${baseUrlLine}`, ...modelLines].join(
				"\n",
			);
		});
		return `${badge("Providers", String(inspection.providers.length), "info")}\n${sections.join("\n\n")}`;
	}

	private buildEnvSection(inspection: ConfigInspection): string {
		if (inspection.envVars.length === 0) {
			return "";
		}
		const lines = inspection.envVars.map((env) => {
			const status = env.set
				? badge("set", undefined, "success")
				: badge("missing", undefined, "warn");
			const value = env.maskedValue
				? muted(env.maskedValue)
				: muted("(not set)");
			return `  ${status} ${chalk.cyan(env.name)} ${value}`;
		});
		return `${badge("Environment variables", String(inspection.envVars.length), "info")}\n${lines.join("\n")}`;
	}

	private buildFileReferenceSection(inspection: ConfigInspection): string {
		if (inspection.fileReferences.length === 0) {
			return "";
		}
		const lines = inspection.fileReferences.map((ref) => {
			const rel = ref.path.replace(homedir(), "~");
			const status = ref.exists
				? badge("present", undefined, "success")
				: badge("missing", undefined, "danger");
			const size =
				typeof ref.size === "number"
					? muted(` (${formatBytes(ref.size)})`)
					: "";
			return `  ${status} ${muted(rel)}${size}`;
		});
		return `${badge("File references", String(inspection.fileReferences.length), "info")}\n${lines.join("\n")}`;
	}

	private showSourcesOnly(): void {
		try {
			const inspection = inspectConfig();
			const hierarchy = getConfigHierarchy();
			const sources = this.buildSourcesSection(inspection, hierarchy);
			const body =
				sources ||
				chalk.dim(
					"No configuration sources were discovered for this workspace.",
				);
			this.render(`${badge("Config sources", undefined, "info")}\n${body}`);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to load configuration sources";
			this.options.showError(`Config sources failed: ${message}`);
		}
	}

	private renderHelp(): void {
		const content = [
			chalk.bold("/config usage"),
			"/config — show validation + provider summary",
			"/config sources — list config files and whether they loaded",
			"/config help — show this help message",
		].join("\n");
		this.render(content);
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
