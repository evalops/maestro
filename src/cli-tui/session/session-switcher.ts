import { Column, Row, Text } from "@evalops/tui";
import chalk from "chalk";
import type {
	SessionDataProvider,
	SessionItem,
} from "./session-data-provider.js";

interface SessionSwitcherComponentOptions {
	dataProvider: SessionDataProvider;
	onSelect: (session: SessionItem) => void;
	onCancel: () => void;
	onToggleFavorite: (session: SessionItem, favorite: boolean) => void;
	onSummarize: (session: SessionItem) => Promise<void> | void;
}

export class SessionSwitcherComponent extends Column {
	private sessions: SessionItem[] = [];
	private filteredSessions: SessionItem[] = [];
	private selectedIndex = 0;
	private showFavoritesOnly = false;
	private tabsText: Text;
	private listContainer: Column;
	private statusText: Text;

	constructor(private readonly options: SessionSwitcherComponentOptions) {
		super([], { gap: 1 });

		const cwd = process.cwd();
		this.addChild(new Text(chalk.gray(`Current folder: ${cwd}`), 0, 0));
		this.addChild(new Text(chalk.bold("Select a session"), 0, 0));

		this.tabsText = new Text("", 0, 0);
		this.addChild(this.tabsText);

		this.listContainer = new Column([], { gap: 0 });
		this.addChild(this.listContainer);

		this.statusText = new Text("", 0, 0);
		this.addChild(this.statusText);

		this.reloadSessions();
	}

	private reloadSessions(force = false): void {
		this.sessions = this.options.dataProvider.loadSessions(force);
		this.applyFilters();
	}

	refresh(force = false): void {
		this.reloadSessions(force);
	}

	private applyFilters(): void {
		this.filteredSessions = this.showFavoritesOnly
			? this.sessions.filter((session) => session.favorite)
			: this.sessions;
		if (this.filteredSessions.length === 0) {
			this.selectedIndex = 0;
		} else {
			this.selectedIndex = Math.min(
				this.selectedIndex,
				Math.max(0, this.filteredSessions.length - 1),
			);
		}
		this.updateTabs();
		this.updateList();
	}

	private toggleFavoritesFilter(): void {
		this.showFavoritesOnly = !this.showFavoritesOnly;
		this.applyFilters();
	}

	private updateTabs(): void {
		const allLabel = this.showFavoritesOnly
			? chalk.gray("All")
			: chalk.hex("#f97316")("All");
		const favLabel = this.showFavoritesOnly
			? chalk.hex("#f97316")("Favorites")
			: chalk.gray("Favorites");
		this.tabsText.setText(`• ${allLabel} | ${favLabel}`);
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredSessions.length === 0) {
			const emptyMessage = this.showFavoritesOnly
				? "No favorite sessions yet."
				: "No saved sessions for this project.";
			this.listContainer.addChild(
				new Text(chalk.gray(`  ${emptyMessage}`), 0, 0),
			);
			this.updateStatus();
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filteredSessions.length - maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + maxVisible,
			this.filteredSessions.length,
		);

		for (let i = startIndex; i < endIndex; i++) {
			const session = this.filteredSessions[i];
			if (!session) continue;
			const isSelected = i === this.selectedIndex;
			const row = this.renderRow(session, isSelected);
			this.listContainer.addChild(row);
		}

		const rangeInfo = chalk.gray(
			`  Showing ${startIndex + 1}-${endIndex} of ${this.filteredSessions.length}`,
		);
		this.listContainer.addChild(new Text(rangeInfo, 0, 0));
		this.updateStatus();
	}

	private renderRow(session: SessionItem, isSelected: boolean): Row {
		const pointer = isSelected ? chalk.blue("→") : " ";
		const star = session.favorite ? chalk.yellow("*") : " ";
		const modified = this.formatRelative(session.modified);
		const created = this.formatRelative(session.created);
		const size = this.formatSize(session.size);
		const summary = this.truncate(session.summary || session.firstMessage, 60);

		const colorize = (value: string) =>
			isSelected ? chalk.blue(value) : value;

		const row = new Row(
			[
				new Text(colorize(`${pointer} ${star}`), 0, 0),
				new Text(colorize(modified), 0, 0),
				new Text(colorize(created), 0, 0),
				new Text(colorize(size), 0, 0),
				new Text(colorize(summary), 0, 0),
			],
			{
				gap: 2,
				weights: [1, 1, 1, 1, 4],
				minWidths: [4, 6, 6, 4, 10],
				justify: "space-between",
				wrap: true,
				align: "center",
			},
		);
		row.setChildOptions(row.children[0]!, { maxWidth: 4 });
		row.setChildOptions(row.children[4]!, { minWidth: 10 });
		return row;
	}

	private updateStatus(): void {
		const hint =
			"↑/↓ navigate • Enter select • Space star • Tab/F filter • S summarize • ESC/Q cancel";
		this.statusText.setText(chalk.gray(hint));
	}

	private truncate(text: string, max = 60): string {
		if (!text) return "(empty)";
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	}

	private formatRelative(date: Date): string {
		const diff = Date.now() - date.getTime();
		const minutes = Math.floor(diff / 60000);
		if (minutes < 1) return "now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	private formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`;
		return `${Math.round(bytes / (1024 * 1024))}m`;
	}

	private moveSelection(delta: number): void {
		if (this.filteredSessions.length === 0) {
			return;
		}
		this.selectedIndex = Math.max(
			0,
			Math.min(this.selectedIndex + delta, this.filteredSessions.length - 1),
		);
		this.updateList();
	}

	private selectCurrent(): void {
		const session = this.filteredSessions[this.selectedIndex];
		if (session) {
			this.options.onSelect(session);
		}
	}

	private summarizeCurrent(): void {
		const session = this.filteredSessions[this.selectedIndex];
		if (!session) return;
		void this.options.onSummarize(session);
	}

	private toggleFavoriteForSelection(): void {
		const session = this.filteredSessions[this.selectedIndex];
		if (!session) {
			return;
		}
		const nextFavorite = !session.favorite;
		this.options.onToggleFavorite(session, nextFavorite);
		const previousPath = session.path;
		this.reloadSessions(true);
		const newIndex = this.filteredSessions.findIndex(
			(item) => item.path === previousPath,
		);
		if (newIndex >= 0) {
			this.selectedIndex = newIndex;
		}
		this.updateList();
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			this.moveSelection(-1);
			return;
		}
		if (keyData === "\x1b[B") {
			this.moveSelection(1);
			return;
		}
		if (keyData === "\r") {
			this.selectCurrent();
			return;
		}
		if (keyData === "\t" || keyData.toLowerCase() === "f") {
			this.toggleFavoritesFilter();
			return;
		}
		if (keyData === " ") {
			this.toggleFavoriteForSelection();
			return;
		}
		if (keyData.toLowerCase() === "s") {
			this.summarizeCurrent();
			return;
		}
		if (keyData === "\x1b" || keyData.toLowerCase() === "q") {
			this.options.onCancel();
			return;
		}
		if (keyData.toLowerCase() === "r") {
			this.reloadSessions(true);
			return;
		}
	}
}
