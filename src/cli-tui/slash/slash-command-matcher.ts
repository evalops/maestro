/**
 * Slash command matching and scoring logic.
 *
 * Extracted from TuiRenderer to provide reusable command matching
 * with support for favorites and recents.
 */

import type { SlashCommand } from "@evalops/tui";

/**
 * Options for matching slash commands.
 */
export interface SlashMatchOptions {
	/** Commands marked as favorites get priority */
	favorites: Set<string>;
	/** Recently used commands get priority */
	recents: Set<string>;
}

/**
 * Handles slash command matching and scoring.
 */
export class SlashCommandMatcher {
	constructor(private readonly commands: SlashCommand[]) {}

	/**
	 * Get commands matching a query, sorted by relevance.
	 */
	getMatches(query: string, options: SlashMatchOptions): SlashCommand[] {
		const q = query.trim().toLowerCase();
		const { favorites, recents } = options;

		const scored = this.commands
			.map((cmd) => ({
				cmd,
				score: this.scoreCommand(cmd, q, favorites, recents),
			}))
			.filter((item) => item.score > 0 || !q)
			.sort(
				(a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name),
			);

		return scored.map((s) => s.cmd);
	}

	/**
	 * Score a command based on query match and user preferences.
	 *
	 * Scoring tiers:
	 * - Exact match: 100
	 * - Prefix match: 70 (name) / 55 (alias)
	 * - Contains match: 25 (name) / 15 (alias)
	 * - Favorite bonus: 12 (with query) / 8 (no query)
	 * - Recent bonus: 8 (with query) / 5 (no query)
	 */
	private scoreCommand(
		cmd: SlashCommand,
		query: string,
		favorites: Set<string>,
		recents: Set<string>,
	): number {
		let score = 0;
		const name = cmd.name.toLowerCase();
		const aliases = (cmd.aliases ?? []).map((a: string) => a.toLowerCase());

		// No query - just rank by favorites/recents
		if (!query) {
			score += favorites.has(cmd.name) ? 8 : 0;
			score += recents.has(cmd.name) ? 5 : 0;
			return score;
		}

		// Exact match (highest priority)
		if (name === query || aliases.includes(query)) {
			score += 100;
		}

		// Prefix match
		if (name.startsWith(query)) {
			score += 70;
		}
		if (aliases.some((a) => a.startsWith(query))) {
			score += 55;
		}

		// Contains match
		if (name.includes(query)) {
			score += 25;
		}
		if (aliases.some((a) => a.includes(query))) {
			score += 15;
		}

		// User preference bonuses
		score += favorites.has(cmd.name) ? 12 : 0;
		score += recents.has(cmd.name) ? 8 : 0;

		return score;
	}
}

/**
 * Manages cycling through slash command completions.
 */
export class SlashCycleState {
	private query: string | null = null;
	private index = 0;

	/**
	 * Cycle to the next/previous match.
	 * Returns the replacement command name, or null if no matches.
	 */
	cycle(
		currentQuery: string,
		matches: SlashCommand[],
		reverse = false,
	): string | null {
		if (matches.length === 0) {
			return null;
		}

		// Reset index if query changed
		if (this.query !== currentQuery) {
			this.query = currentQuery;
			this.index = 0;
		} else {
			// Cycle through matches
			if (reverse) {
				this.index = (this.index - 1 + matches.length) % matches.length;
			} else {
				this.index = (this.index + 1) % matches.length;
			}
		}

		return matches[this.index]?.name ?? null;
	}

	/**
	 * Reset cycle state.
	 */
	reset(): void {
		this.query = null;
		this.index = 0;
	}
}
