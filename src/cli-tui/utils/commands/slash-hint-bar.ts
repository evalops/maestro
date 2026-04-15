import type { SlashCommand } from "@evalops/tui";
import { type Component, Text, wrapAnsiLines } from "@evalops/tui";
import chalk from "chalk";

type ScoreFn = (cmd: SlashCommand) => number;

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

/**
 * Renders a slim hint bar above the editor showing the best matching slash command.
 */
export class SlashHintBar implements Component {
	private text = new Text("", 0, 0);

	render(width: number): string[] {
		if (!this.text) return [];
		return wrapAnsiLines(this.text.render(width), width);
	}

	handleInput(): void {
		// no-op; rendering only
	}

	clear(): void {
		this.text.setText("");
	}

	update(
		input: string,
		commands: SlashCommand[],
		recents: Set<string>,
		favorites: Set<string>,
	): void {
		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) {
			this.clear();
			return;
		}
		const [commandToken] = trimmed.split(/\s+/);
		const query = (commandToken ?? "/").slice(1).toLowerCase();
		const scored = this.scoreCommands(commands, query, recents, favorites);
		const best = scored[0];
		if (!best) {
			this.text.setText(chalk.dim("No matching commands · try /help"));
			return;
		}
		const primary = chalk.cyan(`/${best.command.name}`);
		const usage = best.command.usage ? chalk.dim(best.command.usage) : "";
		const desc = best.command.description ?? "";
		const tags = this.renderTags(best.command.tags ?? []);
		const fav = favorites.has(best.command.name)
			? chalk.yellow("★ ")
			: recents.has(best.command.name)
				? chalk.cyan("↺ ")
				: "";
		const example =
			best.command.examples && best.command.examples.length > 0
				? chalk.dim(`e.g. ${best.command.examples[0]}`)
				: "";
		const tip = chalk.dim("Tab cycle · ? help");
		const line = [fav + primary, usage, tags, tip].filter(Boolean).join("  ");
		const sub = [desc, example].filter(Boolean).join("  ");
		const body = sub ? `${line}\n${chalk.dim(sub)}` : line;
		this.text.setText(body);
	}

	private scoreCommands(
		commands: SlashCommand[],
		query: string,
		recents: Set<string>,
		favorites: Set<string>,
	): Array<{ command: SlashCommand; score: number }> {
		const q = query.trim();
		const score: ScoreFn = (cmd) => {
			let s = 0;
			if (!q) {
				s += recents.has(cmd.name) ? 6 : 0;
				s += favorites.has(cmd.name) ? 8 : 0;
				return s;
			}
			const name = cmd.name.toLowerCase();
			const aliases = (cmd.aliases ?? []).map((a) => a.toLowerCase());
			if (name === q || aliases.includes(q)) s += 100;
			if (name.startsWith(q)) s += 70;
			if (aliases.some((a) => a.startsWith(q))) s += 55;
			if (name.includes(q)) s += 25;
			if (aliases.some((a) => a.includes(q))) s += 15;
			s += favorites.has(cmd.name) ? 12 : 0;
			s += recents.has(cmd.name) ? 8 : 0;
			return s;
		};
		return commands
			.map((cmd) => ({ command: cmd, score: score(cmd) }))
			.filter((item) => item.score > 0 || !q) // allow empty query recommendations
			.sort(
				(a, b) =>
					b.score - a.score || a.command.name.localeCompare(b.command.name),
			)
			.slice(0, 5);
	}

	private renderTags(tags: string[]): string {
		return tags
			.map((tag) => {
				const color = TAG_COLORS[tag] ?? "#94a3b8";
				return chalk.hex(color)(`[${tag}]`);
			})
			.join(" ");
	}
}
