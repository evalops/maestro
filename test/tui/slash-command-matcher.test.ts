import type { SlashCommand } from "@evalops/tui";
import { describe, expect, it } from "vitest";
import {
	SlashCommandMatcher,
	SlashCycleState,
} from "../../src/cli-tui/slash/index.js";

function makeCommand(
	name: string,
	opts: { aliases?: string[]; description?: string } = {},
): SlashCommand {
	return {
		name,
		aliases: opts.aliases,
		description: opts.description ?? `${name} command`,
	};
}

describe("SlashCommandMatcher", () => {
	const commands: SlashCommand[] = [
		makeCommand("help", { aliases: ["h"] }),
		makeCommand("quit", { aliases: ["q", "exit"] }),
		makeCommand("session", { aliases: ["s"] }),
		makeCommand("sessions", { aliases: ["ss"] }),
		makeCommand("export", { aliases: ["e"] }),
		makeCommand("model"),
		makeCommand("theme"),
		makeCommand("clear"),
	];

	const matcher = new SlashCommandMatcher(commands);

	describe("getMatches", () => {
		it("returns all commands when query is empty", () => {
			const matches = matcher.getMatches("", {
				favorites: new Set(),
				recents: new Set(),
			});
			expect(matches).toHaveLength(commands.length);
		});

		it("exact match scores highest", () => {
			const matches = matcher.getMatches("help", {
				favorites: new Set(),
				recents: new Set(),
			});
			expect(matches[0]!.name).toBe("help");
		});

		it("alias exact match scores high", () => {
			const matches = matcher.getMatches("h", {
				favorites: new Set(),
				recents: new Set(),
			});
			expect(matches[0]!.name).toBe("help");
		});

		it("prefix match works", () => {
			const matches = matcher.getMatches("se", {
				favorites: new Set(),
				recents: new Set(),
			});
			// Both "session" and "sessions" should match
			const names = matches.map((m) => m.name);
			expect(names).toContain("session");
			expect(names).toContain("sessions");
		});

		it("contains match works", () => {
			const matches = matcher.getMatches("ear", {
				favorites: new Set(),
				recents: new Set(),
			});
			// "clear" contains "ear"
			const names = matches.map((m) => m.name);
			expect(names).toContain("clear");
		});

		it("favorites are prioritized with empty query", () => {
			const matches = matcher.getMatches("", {
				favorites: new Set(["theme"]),
				recents: new Set(),
			});
			expect(matches[0]!.name).toBe("theme");
		});

		it("recents are prioritized with empty query", () => {
			const matches = matcher.getMatches("", {
				favorites: new Set(),
				recents: new Set(["model"]),
			});
			expect(matches[0]!.name).toBe("model");
		});

		it("favorites outrank recents", () => {
			const matches = matcher.getMatches("", {
				favorites: new Set(["theme"]),
				recents: new Set(["model"]),
			});
			expect(matches[0]!.name).toBe("theme");
			expect(matches[1]!.name).toBe("model");
		});

		it("returns empty array when no matches", () => {
			const matches = matcher.getMatches("xyz", {
				favorites: new Set(),
				recents: new Set(),
			});
			expect(matches).toHaveLength(0);
		});

		it("case insensitive matching", () => {
			const matches = matcher.getMatches("HELP", {
				favorites: new Set(),
				recents: new Set(),
			});
			expect(matches[0]!.name).toBe("help");
		});

		it("alias prefix match works", () => {
			const matches = matcher.getMatches("ex", {
				favorites: new Set(),
				recents: new Set(),
			});
			// "quit" has alias "exit" which starts with "ex"
			// "export" also starts with "ex"
			const names = matches.map((m) => m.name);
			expect(names).toContain("quit");
			expect(names).toContain("export");
		});
	});
});

describe("SlashCycleState", () => {
	const commands: SlashCommand[] = [
		makeCommand("session"),
		makeCommand("sessions"),
		makeCommand("stats"),
	];

	it("cycles through matches forward", () => {
		const state = new SlashCycleState();

		const first = state.cycle("s", commands, false);
		expect(first).toBe("session");

		const second = state.cycle("s", commands, false);
		expect(second).toBe("sessions");

		const third = state.cycle("s", commands, false);
		expect(third).toBe("stats");

		// Wraps around
		const fourth = state.cycle("s", commands, false);
		expect(fourth).toBe("session");
	});

	it("cycles through matches backward", () => {
		const state = new SlashCycleState();

		const first = state.cycle("s", commands, false);
		expect(first).toBe("session");

		// Go backward (wraps to end)
		const second = state.cycle("s", commands, true);
		expect(second).toBe("stats");

		const third = state.cycle("s", commands, true);
		expect(third).toBe("sessions");
	});

	it("resets index when query changes", () => {
		const state = new SlashCycleState();

		state.cycle("s", commands, false); // session
		state.cycle("s", commands, false); // sessions

		// Change query - should reset to first match
		const otherCommands = [makeCommand("theme"), makeCommand("thinking")];
		const result = state.cycle("t", otherCommands, false);
		expect(result).toBe("theme");
	});

	it("returns null for empty matches", () => {
		const state = new SlashCycleState();
		const result = state.cycle("xyz", [], false);
		expect(result).toBeNull();
	});

	it("reset clears state", () => {
		const state = new SlashCycleState();

		state.cycle("s", commands, false); // session
		state.cycle("s", commands, false); // sessions

		state.reset();

		// After reset, should start from beginning again
		const result = state.cycle("s", commands, false);
		expect(result).toBe("session");
	});
});
