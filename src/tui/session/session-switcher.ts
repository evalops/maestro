import { Container, Spacer, Text } from "@evalops/tui";
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

export class SessionSwitcherComponent extends Container {
	private sessions: SessionItem[] = [];
	private filteredSessions: SessionItem[] = [];
	private selectedIndex = 0;
	private showFavoritesOnly = false;
	private tabsText: Text;
	private listContainer: Container;
	private statusText: Text;

	constructor(private readonly options: SessionSwitcherComponentOptions) {
		super();

		const cwd = process.cwd();
		this.addChild(new Text(chalk.gray(`Current folder: ${cwd}`), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(chalk.bold("Select a session"), 0, 0));

		this.tabsText = new Text("", 0, 0);
		this.addChild(this.tabsText);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

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
			const line = this.renderRow(session, isSelected);
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		const rangeInfo = chalk.gray(
			`  Showing ${startIndex + 1}-${endIndex} of ${this.filteredSessions.length}`,
		);
		this.listContainer.addChild(new Text(rangeInfo, 0, 0));
		this.updateStatus();
	}

	private renderRow(session: SessionItem, isSelected: boolean): string {
		const pointer = isSelected ? chalk.blue("→") : " ";
		const star = session.favorite ? chalk.yellow("*") : " ";
		const modified = this.formatRelative(session.modified).padEnd(8);
		const created = this.formatRelative(session.created).padEnd(8);
		const size = this.formatSize(session.size).padStart(6);
		const summary = this.truncate(session.summary || session.firstMessage, 60);
		const line = `${pointer} ${star} ${modified}  ${created}  ${size}  ${summary}`;
		return isSelected ? chalk.blue(line) : line;
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
