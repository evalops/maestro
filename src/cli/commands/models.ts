import chalk from "chalk";
import { getRegisteredModels } from "../../models/registry.js";
import type { RegisteredModel } from "../../models/registry.js";
import { getEnvVarsForProvider } from "../../providers/api-keys.js";
import { badge, muted, sectionHeading, separator } from "../../style/theme.js";

function formatReasoning(model: RegisteredModel): string {
	return model.reasoning
		? badge("reasoning", "on", "success")
		: badge("reasoning", "off", "warn");
}

function formatSource(model: RegisteredModel): string {
	return model.source === "custom"
		? badge("custom", undefined, "success")
		: badge("builtin", undefined, "info");
}

function printModelEntry(model: RegisteredModel): void {
	const localBadge = model.isLocal
		? ` ${badge("local", undefined, "warn")}`
		: "";
	console.log(
		`  • ${chalk.bold(model.id)} ${separator()} ${muted(model.name)}`,
	);
	console.log(
		`    ${formatReasoning(model)}${separator()}${badge(
			"context",
			model.contextWindow.toLocaleString(),
		)}${separator()}${badge("max", model.maxTokens.toLocaleString())}${separator()}${formatSource(model)}${localBadge}`,
	);
	console.log(muted(`    ${model.baseUrl}`));
}

function filterModels(providerFilter?: string): RegisteredModel[] {
	const models = getRegisteredModels();
	if (!providerFilter) {
		return models;
	}
	return models.filter((model) => model.provider === providerFilter);
}

function printEmptyState(providerFilter?: string): void {
	if (providerFilter) {
		console.error(
			chalk.red(`No models registered for provider "${providerFilter}".`),
		);
	} else {
		console.log(badge("No models registered", undefined, "warn"));
	}
	process.exit(providerFilter ? 1 : 0);
}

export async function handleModelsList(providerFilter?: string): Promise<void> {
	console.log(sectionHeading("📚 Registered Models"));
	const filtered = filterModels(providerFilter);
	if (filtered.length === 0) {
		printEmptyState(providerFilter);
		return;
	}

	if (providerFilter) {
		console.log(muted(`Filter: ${providerFilter}`));
		console.log();
	}

	const grouped = new Map<string, RegisteredModel[]>();
	for (const model of filtered) {
		const bucket = grouped.get(model.provider);
		if (bucket) {
			bucket.push(model);
		} else {
			grouped.set(model.provider, [model]);
		}
	}

	const providers = Array.from(grouped.keys()).sort((a, b) =>
		a.localeCompare(b),
	);
	for (const provider of providers) {
		const entries = grouped.get(provider);
		if (!entries) continue;
		entries.sort((a, b) => a.id.localeCompare(b.id));
		const providerLabel = entries[0]?.providerName ?? provider;
		console.log(
			`${chalk.cyan(provider)} ${separator()} ${badge(
				"models",
				String(entries.length),
			)}`,
		);
		console.log(muted(`  ${providerLabel}`));
		for (const model of entries) {
			printModelEntry(model);
		}
		console.log();
	}

	process.exit(0);
}

interface ProviderStats {
	provider: string;
	name: string;
	total: number;
	builtin: number;
	custom: number;
	baseUrls: Set<string>;
	localCount: number;
}

function buildProviderStats(
	models: RegisteredModel[],
): Map<string, ProviderStats> {
	const stats = new Map<string, ProviderStats>();
	for (const model of models) {
		let entry = stats.get(model.provider);
		if (!entry) {
			entry = {
				provider: model.provider,
				name: model.providerName,
				total: 0,
				builtin: 0,
				custom: 0,
				baseUrls: new Set(),
				localCount: 0,
			};
			stats.set(model.provider, entry);
		}
		entry.total += 1;
		if (model.source === "custom") {
			entry.custom += 1;
		} else {
			entry.builtin += 1;
		}
		if (model.isLocal) {
			entry.localCount += 1;
		}
		entry.baseUrls.add(model.baseUrl);
	}
	return stats;
}

export async function handleModelsProviders(
	providerFilter?: string,
): Promise<void> {
	console.log(sectionHeading("🛰 Provider Overview"));
	const stats = buildProviderStats(getRegisteredModels());
	if (providerFilter && !stats.has(providerFilter)) {
		printEmptyState(providerFilter);
		return;
	}
	const providers = providerFilter
		? [providerFilter]
		: Array.from(stats.keys()).sort((a, b) => a.localeCompare(b));
	for (const provider of providers) {
		const entry = stats.get(provider);
		if (!entry) {
			continue;
		}
		const envVars = getEnvVarsForProvider(provider);
		const baseUrls = Array.from(entry.baseUrls);
		const sourceSummary = [];
		if (entry.builtin > 0) sourceSummary.push(`${entry.builtin} builtin`);
		if (entry.custom > 0) sourceSummary.push(`${entry.custom} custom`);
		const localLabel = entry.localCount
			? `${entry.localCount} local endpoint${entry.localCount === 1 ? "" : "s"}`
			: "no local endpoints";
		console.log(
			`${chalk.cyan(provider)} ${separator()} ${badge(
				"models",
				String(entry.total),
			)}`,
		);
		console.log(
			muted(`  ${entry.name} (${sourceSummary.join(", ") || "0 models"})`),
		);
		console.log(muted(`  ${localLabel}`));
		const envLabel = envVars.length
			? envVars.join(", ")
			: "(custom or not configured)";
		console.log(
			`  ${badge("API key env", envLabel, envVars.length ? "info" : "warn")}`,
		);
		if (baseUrls.length > 0) {
			console.log(muted("  Base URLs:"));
			for (const url of baseUrls.slice(0, 3)) {
				console.log(muted(`    • ${url}`));
			}
			if (baseUrls.length > 3) {
				console.log(
					muted(`    • ... and ${baseUrls.length - 3} more endpoints`),
				);
			}
		} else {
			console.log(muted("  Base URLs: (none)"));
		}
		console.log();
	}

	process.exit(0);
}
