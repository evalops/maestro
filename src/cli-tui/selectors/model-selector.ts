import { Container, Input, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { RegisteredModel } from "../../models/registry.js";
import {
	getRegisteredModels,
	reloadModelConfig,
} from "../../models/registry.js";
import {
	type SupportedOAuthProvider,
	hasOAuthCredentials,
} from "../../oauth/index.js";
import { lookupApiKey } from "../../providers/api-keys.js";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container {
	private searchInput: Input;
	private listContainer: Container;
	private allModels: RegisteredModel[] = [];
	private filteredModels: RegisteredModel[] = [];
	private selectedIndex = 0;
	private currentModel: RegisteredModel;
	private onSelectCallback: (model: RegisteredModel) => void;
	private onCancelCallback: () => void;
	private filteredForCredentials = false;
	private credentialHints: string[] = [];
	private modelScope: RegisteredModel[] = [];
	private isScoped = false;

	constructor(
		currentModel: RegisteredModel,
		onSelect: (model: RegisteredModel) => void,
		onCancel: () => void,
		modelScope: RegisteredModel[] = [],
	) {
		super();

		this.currentModel = currentModel;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.modelScope = modelScope;
		this.isScoped = modelScope.length > 0;

		// Load all models
		this.loadModels();

		// Add top border
		this.addChild(new Text(chalk.blue("─".repeat(80)), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.handleSelect(selected);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new Text(chalk.blue("─".repeat(80)), 0, 0));

		// Initial render
		this.updateList();
	}

	private loadModels(): void {
		// Always reload config so edits to models.json are visible
		reloadModelConfig();
		const models = getRegisteredModels();
		const scopedModels = this.isScoped
			? this.applyModelScope(models, this.modelScope)
			: models;
		const hints = new Set<string>();
		const filtered = scopedModels.filter((model) => {
			const result = this.isModelUsable(model);
			if (!result.usable && result.hint) {
				hints.add(result.hint);
			}
			return result.usable;
		});
		this.filteredForCredentials = filtered.length !== scopedModels.length;
		this.credentialHints = Array.from(hints);
		filtered.sort((a, b) => {
			const aIsCurrent = this.currentModel?.id === a.id;
			const bIsCurrent = this.currentModel?.id === b.id;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.providerName.localeCompare(b.providerName);
		});
		this.allModels = filtered;
		this.filteredModels = filtered;
	}

	private applyModelScope(
		models: RegisteredModel[],
		scope: RegisteredModel[],
	): RegisteredModel[] {
		if (scope.length === 0) return models;
		const scopeKeys = new Set(
			scope.map((model) => `${model.provider}/${model.id}`),
		);
		return models.filter((model) =>
			scopeKeys.has(`${model.provider}/${model.id}`),
		);
	}

	private filterModels(query: string): void {
		if (!query.trim()) {
			this.filteredModels = this.allModels;
		} else {
			const searchTokens = query
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t);
			this.filteredModels = this.allModels.filter(
				({ providerName, id, name, source }) => {
					const searchText =
						`${providerName} ${id} ${name ?? ""} ${source}`.toLowerCase();
					return searchTokens.every((token) => searchText.includes(token));
				},
			);
		}

		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredModels.length - 1),
		);
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredForCredentials && this.credentialHints.length > 0) {
			const hintText = this.credentialHints
				.map((hint) => `• ${hint}`)
				.join("\n");
			this.listContainer.addChild(
				new Text(chalk.yellow(`Missing credentials:\n${hintText}`), 0, 0),
			);
			this.listContainer.addChild(new Spacer(1));
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filteredModels.length - maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + maxVisible,
			this.filteredModels.length,
		);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = this.currentModel?.id === item.id;

			const providerLabels = [chalk.gray(`[${item.providerName}]`)];
			if (item.isLocal) {
				providerLabels.push(chalk.hex("#fbbf24")("[local]"));
			}
			const providerBadge = providerLabels.join(" ");
			let line = "";
			if (isSelected) {
				const prefix = chalk.blue("→ ");
				const modelText = `${item.id}`;
				const checkmark = isCurrent ? chalk.green(" ✓") : "";
				line = `${prefix}${chalk.blue(modelText)} ${providerBadge}${checkmark}`;
			} else {
				const modelText = `  ${item.id}`;
				const checkmark = isCurrent ? chalk.green(" ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = chalk.gray(
				`  (${this.selectedIndex + 1}/${this.filteredModels.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(
				new Text(
					chalk.gray(
						this.filteredForCredentials
							? "  No models with configured credentials"
							: "  No matching models",
					),
					0,
					0,
				),
			);
		}
	}

	handleInput(keyData: string): void {
		// Up arrow
		if (keyData === "\x1b[A") {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (keyData === "\x1b[B") {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = Math.min(
				this.filteredModels.length - 1,
				this.selectedIndex + 1,
			);
			this.updateList();
		}
		// Enter
		else if (keyData === "\r") {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel);
			}
		}
		// Escape
		else if (keyData === "\x1b") {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: RegisteredModel): void {
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	private isModelUsable(model: RegisteredModel): {
		usable: boolean;
		hint?: string;
	} {
		// Always allow local endpoints; otherwise require a key
		if (model.isLocal) return { usable: true };
		const oauthProviders = new Set<SupportedOAuthProvider>([
			"anthropic",
			"evalops",
			"openai",
			"github-copilot",
			"google-gemini-cli",
			"google-antigravity",
		]);
		if (
			oauthProviders.has(model.provider as SupportedOAuthProvider) &&
			hasOAuthCredentials(model.provider as SupportedOAuthProvider)
		) {
			return { usable: true };
		}
		const apiKey = lookupApiKey(model.provider);
		if (apiKey.source !== "missing") {
			return { usable: true };
		}
		const envOptions =
			apiKey.envVar && apiKey.envVar.length > 0
				? [apiKey.envVar]
				: apiKey.checkedEnvVars;
		const envHint = envOptions?.length
			? `Set ${envOptions.join(" or ")} for ${model.providerName ?? model.provider}`
			: `Configure credentials for ${model.providerName ?? model.provider}`;
		return { usable: false, hint: envHint };
	}
}
