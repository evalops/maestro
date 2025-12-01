import type { SlashCommand } from "@evalops/tui";
import { Container, Text } from "@evalops/tui";
import { type SelectItem, SelectList } from "@evalops/tui";
import chalk from "chalk";

type FavoriteToggler = (name: string) => void;

const TAG_COLORS: Record<string, string> = {
	git: "#f97316",
	safety: "#facc15",
	session: "#22c55e",
	ui: "#38bdf8",
	diagnostics: "#c084fc",
	tools: "#67e8f9",
	automation: "#f472b6",
	auth: "#f59e0b",
	system: "#e2e8f0",
	usage: "#7dd3fc",
	planning: "#f9a8d4",
};

export class CommandPaletteComponent extends Container {
	private list: SelectList;
	private filterText: Text;
	private detailText: Text;
	private legendText: Text;
	private filter = "";
	private items: SelectItem[];
	private commandMap = new Map<string, SlashCommand>();
	private recentSet: Set<string>;
	private favoriteSet: Set<string>;

	constructor(
		commands: SlashCommand[],
		recents: string[],
		favorites: Set<string>,
		private readonly onSelect: (command: SlashCommand) => void,
		private readonly onCancel: () => void,
		private readonly onToggleFavorite: FavoriteToggler,
	) {
		super();

		this.recentSet = new Set(recents);
		this.favoriteSet = new Set(favorites);

		for (const cmd of commands) {
			this.commandMap.set(cmd.name, cmd);
		}

		this.items = this.buildItems(commands);

		this.addChild(new Text(chalk.hex("#7c3aed")("━".repeat(64)), 0, 0));
		this.filterText = new Text(this.buildPrompt(), 1, 0);
		this.addChild(this.filterText);
		this.legendText = new Text(
			chalk.dim("Tab navigate • f favorite • ? examples • Esc close"),
			1,
			0,
		);
		this.addChild(this.legendText);

		this.list = new SelectList(this.items, 9);
		this.list.onSelect = (item) => {
			const command = this.commandMap.get(this.extractName(item.value));
			if (command) {
				this.onSelect(command);
			}
		};
		this.list.onCancel = this.onCancel;
		this.list.onSelectionChange = (item) => this.updateDetails(item);
		this.addChild(this.list);

		this.detailText = new Text("", 1, 0);
		this.addChild(this.detailText);
		this.addChild(new Text(chalk.hex("#7c3aed")("━".repeat(64)), 0, 0));

		const firstItem = this.list.getSelectedItem();
		if (firstItem) {
			this.updateDetails(firstItem);
		}
	}

	handleInput(keyData: string): void {
		// Backspace
		if (keyData === "\x7f" || keyData === "\x08") {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Toggle favorite
		if (keyData === "f") {
			const item = this.list.getSelectedItem();
			if (item) {
				const name = this.extractName(item.value);
				if (this.favoriteSet.has(name)) {
					this.favoriteSet.delete(name);
				} else {
					this.favoriteSet.add(name);
				}
				this.onToggleFavorite(name);
				this.rebuildList();
				return;
			}
		}

		// Show example in details
		if (keyData === "?") {
			this.updateDetails(this.list.getSelectedItem(), true);
			return;
		}

		// Tab to move down the list (mirrors common palette behavior)
		if (keyData === "\t") {
			this.list.handleInput("\x1b[B");
			return;
		}

		if (
			keyData.length === 1 &&
			keyData >= " " &&
			keyData <= "~" &&
			keyData !== "\r"
		) {
			this.filter += keyData;
			this.updateFilter();
			return;
		}

		this.list.handleInput(keyData);
	}

	private buildItems(commands: SlashCommand[]): SelectItem[] {
		const favorites: SelectItem[] = [];
		const recents: SelectItem[] = [];
		const rest: SelectItem[] = [];

		for (const cmd of commands) {
			const badgeText = this.renderBadges(cmd.tags ?? []);
			const isFavorite = this.favoriteSet.has(cmd.name);
			const isRecent = this.recentSet.has(cmd.name);
			const labelPrefix = `${isFavorite ? "★" : " "}${
				isRecent ? "↺" : " "
			} /${cmd.name}`;
			const item: SelectItem = {
				value: this.buildSearchValue(cmd),
				label: labelPrefix,
				description: `${cmd.description ?? ""} ${badgeText}`.trim(),
			};
			if (isFavorite) {
				favorites.push(item);
			} else if (isRecent) {
				recents.push(item);
			} else {
				rest.push(item);
			}
		}

		const byName = (a: SelectItem, b: SelectItem) =>
			this.extractName(a.value).localeCompare(this.extractName(b.value));

		return [
			...favorites.sort(byName),
			...recents.sort(byName),
			...rest.sort(byName),
		];
	}

	private renderBadges(tags: string[]): string {
		return tags
			.map((tag) => {
				const color = TAG_COLORS[tag] ?? "#94a3b8";
				return chalk.hex(color)(`[${tag}]`);
			})
			.join(" ");
	}

	private updateFilter(): void {
		this.filterText.setText(this.buildPrompt());
		const lower = this.filter.toLowerCase();
		this.list.setFilter(lower);
	}

	private buildPrompt(): string {
		const hint = this.filter
			? `/${this.filter}`
			: chalk.dim("Type to search by name, tag, or alias");
		return `${chalk.hex("#a5b4fc")("Command palette")} ${hint}`;
	}

	private updateDetails(item: SelectItem | null, forceExample = false): void {
		if (!item) {
			this.detailText.setText("");
			return;
		}
		const name = this.extractName(item.value);
		const cmd = this.commandMap.get(name);
		if (!cmd) {
			this.detailText.setText("");
			return;
		}
		const usage = cmd.usage ?? `/${cmd.name}`;
		const example = cmd.examples?.[0];
		const tags = cmd.tags?.length ? this.renderBadges(cmd.tags) : "";
		const fav = this.favoriteSet.has(name) ? chalk.yellow("★ favorite · ") : "";
		const recent = this.recentSet.has(name) ? chalk.cyan("↺ recent · ") : "";
		const description = cmd.description ?? "";
		const lines = [
			`${chalk.bold(`/${cmd.name}`)} ${chalk.dim(usage)}`,
			`${fav}${recent}${description}`,
			tags ? `${tags}` : "",
			example && (forceExample || !description)
				? chalk.dim(`e.g. ${example}`)
				: "",
		].filter(Boolean);
		this.detailText.setText(lines.join("\n"));
	}

	private extractName(value: string): string {
		return value.split(" ")[0] ?? value;
	}

	private buildSearchValue(cmd: SlashCommand): string {
		const tags = cmd.tags?.join(" ") ?? "";
		const aliases = cmd.aliases?.join(" ") ?? "";
		return [cmd.name, tags, aliases].filter(Boolean).join(" ");
	}

	private rebuildList(): void {
		const currentName = this.extractName(
			this.list.getSelectedItem()?.value ?? "",
		);
		this.items = this.buildItems(Array.from(this.commandMap.values()));
		const existingIndex = this.children.indexOf(this.list);
		this.removeChild(this.list);
		const newList = new SelectList(this.items, 9);
		newList.setFilter(this.filter.toLowerCase());
		const targetIndex = this.items.findIndex(
			(item) => this.extractName(item.value) === currentName,
		);
		if (targetIndex >= 0) {
			newList.setSelectedIndex(targetIndex);
		}
		newList.onSelect = (i) => {
			const command = this.commandMap.get(this.extractName(i.value));
			if (command) {
				this.onSelect(command);
			}
		};
		newList.onCancel = this.onCancel;
		newList.onSelectionChange = (i) => this.updateDetails(i);
		const insertionIndex = existingIndex >= 0 ? existingIndex : 3;
		this.children.splice(insertionIndex, 0, newList);
		this.list = newList;
		this.updateDetails(this.list.getSelectedItem());
	}
}
