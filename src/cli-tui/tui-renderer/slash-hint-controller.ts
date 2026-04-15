/**
 * SlashHintController - Handles slash command autocomplete and usage tracking
 *
 * Manages:
 * - Slash command hint bar updates
 * - Command cycling (Tab/Shift+Tab)
 * - Recent command tracking
 * - Favorite command management
 */

import type { SlashCommand } from "@evalops/tui";
import type { SlashCommandMatcher, SlashCycleState } from "../slash/index.js";
import type { SlashHintBar } from "../utils/commands/slash-hint-bar.js";

export interface SlashHintControllerDeps {
	/** The slash hint bar component */
	slashHintBar: SlashHintBar;
	/** The slash command matcher */
	slashCommandMatcher: SlashCommandMatcher;
	/** The slash cycle state */
	slashCycleState: SlashCycleState;
	/** Get current slash commands */
	getSlashCommands: () => SlashCommand[];
	/** Get editor text */
	getEditorText: () => string;
	/** Set editor text */
	setEditorText: (text: string) => void;
	/** Check if editor is showing autocomplete */
	isShowingAutocomplete: () => boolean;
}

export interface SlashHintControllerCallbacks {
	/** Persist UI state */
	persistUiState: (extra?: {
		recentCommands?: string[];
		favoriteCommands?: string[];
	}) => void;
	/** Request UI render */
	requestRender: () => void;
}

export interface SlashHintControllerOptions {
	deps: SlashHintControllerDeps;
	callbacks: SlashHintControllerCallbacks;
	initialRecentCommands?: string[];
	initialFavoriteCommands?: Set<string>;
}

export class SlashHintController {
	private readonly deps: SlashHintControllerDeps;
	private readonly callbacks: SlashHintControllerCallbacks;
	private recentCommands: string[];
	private favoriteCommands: Set<string>;
	private debounceTimeout?: NodeJS.Timeout;

	constructor(options: SlashHintControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
		this.recentCommands = options.initialRecentCommands ?? [];
		this.favoriteCommands = options.initialFavoriteCommands ?? new Set();
	}

	/**
	 * Get the current recent commands
	 */
	getRecentCommands(): string[] {
		return this.recentCommands;
	}

	/**
	 * Get the current favorite commands
	 */
	getFavoriteCommands(): Set<string> {
		return this.favoriteCommands;
	}

	/**
	 * Record a command usage, updating recency and persisting state
	 */
	recordCommandUsage(name: string): void {
		// Maintain uniqueness and recency
		this.recentCommands = [
			name,
			...this.recentCommands.filter((n) => n !== name),
		].slice(0, 20);
		this.callbacks.persistUiState({
			recentCommands: this.recentCommands,
			favoriteCommands: Array.from(this.favoriteCommands),
		});
		this.refreshSlashHint();
		this.callbacks.requestRender();
	}

	/**
	 * Toggle favorite status for a command
	 */
	toggleFavoriteCommand(name: string): void {
		if (this.favoriteCommands.has(name)) {
			this.favoriteCommands.delete(name);
		} else {
			this.favoriteCommands.add(name);
		}
		this.callbacks.persistUiState({
			recentCommands: this.recentCommands,
			favoriteCommands: Array.from(this.favoriteCommands),
		});
	}

	/**
	 * Handle Tab/Shift+Tab to cycle through matching slash commands
	 * @returns true if the key was handled, false otherwise
	 */
	handleSlashCycle(reverse = false): boolean {
		const text = this.deps.getEditorText().trim();
		if (!text.startsWith("/")) return false;

		const [commandToken, ...restTokens] = text.split(/\s+/);
		const query = (commandToken ?? "/").slice(1).toLowerCase();
		const matches = this.getSlashMatches(query);

		if (matches.length === 0) return false;

		const replacement = this.deps.slashCycleState.cycle(
			query,
			matches,
			reverse,
		);
		if (!replacement) return false;

		const rest =
			restTokens && restTokens.length > 0 ? ` ${restTokens.join(" ")}` : " ";
		this.deps.setEditorText(`/${replacement}${rest}`);
		this.refreshSlashHint();
		this.callbacks.requestRender();
		return true;
	}

	/**
	 * Get matching slash commands for a query
	 */
	getSlashMatches(query: string): SlashCommand[] {
		return this.deps.slashCommandMatcher.getMatches(query, {
			favorites: this.favoriteCommands,
			recents: new Set(this.recentCommands),
		});
	}

	/**
	 * Refresh the slash hint bar immediately
	 */
	refreshSlashHint(): void {
		if (!this.deps.slashHintBar) return;
		if (this.deps.isShowingAutocomplete()) {
			this.deps.slashHintBar.clear();
			return;
		}
		const text = this.deps.getEditorText();
		this.deps.slashHintBar.update(
			text,
			this.deps.getSlashCommands(),
			new Set(this.recentCommands),
			this.favoriteCommands,
		);
	}

	/**
	 * Refresh the slash hint bar with debouncing
	 */
	refreshSlashHintDebounced(): void {
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
		}
		this.debounceTimeout = setTimeout(() => {
			this.refreshSlashHint();
			// The hint bar can change height (0 ↔ 1–2 lines). Ensure we repaint even if
			// the user pauses typing so the UI stays within the viewport.
			this.callbacks.requestRender();
		}, 30);
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = undefined;
		}
	}
}

export function createSlashHintController(
	options: SlashHintControllerOptions,
): SlashHintController {
	return new SlashHintController(options);
}
