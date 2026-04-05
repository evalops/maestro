/**
 * SkillsController — Manages the /skills command and skill lifecycle.
 *
 * Handles listing, activating, deactivating, and inspecting skills.
 * Maintains the set of currently-active skill names.
 */

import type { AppMessage } from "../../agent/types.js";
import {
	type LoadedSkill,
	type SkillLoadError,
	findSkill,
	formatSkillForInjection,
	formatSkillListItem,
	loadSkills,
	searchSkills,
} from "../../skills/loader.js";
import type { CommandExecutionContext } from "../commands/types.js";
import { formatPreviewBlock } from "../utils/text-preview.js";

// ─── Callback & Dependency Interfaces ────────────────────────────────────────

export interface SkillsControllerCallbacks {
	/** Push markdown/text content into the chat container. */
	pushCommandOutput: (text: string) => void;
	/** Show a transient info notification. */
	showInfo: (message: string) => void;
	/** Show a transient error notification. */
	showError: (message: string) => void;
}

export interface SkillsControllerDeps {
	/** Inject a message into the agent conversation. */
	injectMessage: (message: AppMessage) => void;
	/** Current agent messages, used to avoid duplicate skill restoration. */
	getMessages: () => AppMessage[];
	/** Current working directory (for skill discovery). */
	cwd: () => string;
}

export interface SkillsControllerOptions {
	deps: SkillsControllerDeps;
	callbacks: SkillsControllerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class SkillsController {
	private readonly deps: SkillsControllerDeps;
	private readonly callbacks: SkillsControllerCallbacks;
	private readonly activeSkills = new Set<string>();

	constructor(options: SkillsControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/** Clear all active skills (e.g. on session reset). */
	clearActiveSkills(): void {
		this.activeSkills.clear();
	}

	/**
	 * Re-inject active skill instructions after compaction if they were summarized
	 * away. The current message history is checked first so repeated compactions do
	 * not duplicate still-preserved skill instructions.
	 */
	collectActiveSkillMessagesForCompaction(
		preservedMessages = this.deps.getMessages(),
	): AppMessage[] {
		if (this.activeSkills.size === 0) {
			return [];
		}

		const { skills } = loadSkills(this.deps.cwd());
		const restoredMessages: AppMessage[] = [];

		for (const skillName of this.activeSkills) {
			const skill = findSkill(skills, skillName);
			if (!skill) {
				continue;
			}
			const message = this.buildSkillMessage(skill, "activate");
			if (this.hasMatchingSkillMessage(preservedMessages, message)) {
				continue;
			}
			restoredMessages.push(message);
		}

		return restoredMessages;
	}

	restoreActiveSkillsAfterCompaction(): number {
		const restoredMessages = this.collectActiveSkillMessagesForCompaction();
		for (const message of restoredMessages) {
			this.deps.injectMessage(message);
		}
		return restoredMessages.length;
	}

	// ─── Command Handler ───────────────────────────────────────────────────

	handleSkillsCommand(context: CommandExecutionContext): void {
		const raw = context.argumentText.trim();
		const parts = raw.split(/\s+/).filter(Boolean);
		const subcommand = (parts[0] ?? "list").toLowerCase();

		if (["help", "?", "-h", "--help"].includes(subcommand)) {
			context.renderHelp();
			return;
		}

		const { skills, errors } = loadSkills(this.deps.cwd());

		switch (subcommand) {
			case "list":
			case "ls":
			case "": {
				this.renderSkillsList(skills, errors);
				return;
			}
			case "reload":
			case "refresh": {
				this.renderSkillsList(skills, errors, "Reloaded skills from disk.");
				return;
			}
			case "activate":
			case "enable":
			case "on": {
				const target = parts.slice(1).join(" ").trim();
				if (!target) {
					context.showError("Usage: /skills activate <skill-name>");
					return;
				}
				const resolved = this.resolveSkillTarget(skills, target, context);
				if (!resolved) return;
				if (this.activeSkills.has(resolved.name)) {
					context.showInfo(`Skill "${resolved.name}" is already active.`);
					return;
				}
				this.activeSkills.add(resolved.name);
				this.injectSkillMessage(resolved, "activate");
				context.showInfo(
					`Activated skill "${resolved.name}" (instructions injected).`,
				);
				return;
			}
			case "deactivate":
			case "disable":
			case "off": {
				const target = parts.slice(1).join(" ").trim();
				if (!target) {
					context.showError("Usage: /skills deactivate <skill-name>");
					return;
				}
				const resolved = this.resolveSkillTarget(skills, target, context);
				if (!resolved) return;
				if (!this.activeSkills.has(resolved.name)) {
					context.showInfo(`Skill "${resolved.name}" is not active.`);
					return;
				}
				this.activeSkills.delete(resolved.name);
				this.injectSkillMessage(resolved, "deactivate");
				context.showInfo(`Deactivated skill "${resolved.name}".`);
				return;
			}
			case "info":
			case "show": {
				const target = parts.slice(1).join(" ").trim();
				if (!target) {
					context.showError("Usage: /skills info <skill-name>");
					return;
				}
				const resolved = this.resolveSkillTarget(skills, target, context);
				if (!resolved) return;
				this.renderSkillInfo(resolved);
				return;
			}
			default: {
				const resolved = this.resolveSkillTarget(skills, subcommand, context);
				if (!resolved) return;
				this.renderSkillInfo(resolved);
			}
		}
	}

	// ─── Rendering ─────────────────────────────────────────────────────────

	private renderSkillsList(
		skills: LoadedSkill[],
		errors: SkillLoadError[],
		statusMessage?: string,
	): void {
		const lines: string[] = ["## Available Skills", ""];
		if (statusMessage) {
			lines.push(statusMessage, "");
		}
		if (skills.length === 0 && errors.length === 0) {
			lines.push("*No skills found*");
			lines.push("");
			lines.push("Skills are loaded from:");
			lines.push("- `~/.maestro/skills/` (global)");
			lines.push("- `.maestro/skills/` (project)");
		} else {
			for (const skill of skills) {
				const isActive = this.activeSkills.has(skill.name);
				const suffix = isActive ? " (active)" : "";
				lines.push(`- ${formatSkillListItem(skill)}${suffix}`);
			}
			lines.push("");
			lines.push(`*${skills.length} skill(s) found*`);
			if (this.activeSkills.size > 0) {
				lines.push(
					`Active: ${Array.from(this.activeSkills.values()).join(", ")}`,
				);
			}
		}
		if (errors.length > 0) {
			lines.push("");
			lines.push(`**${errors.length} error(s) loading skills:**`);
			for (const err of errors.slice(0, 5)) {
				lines.push(`- ${err.message ?? "Unknown error"}`);
			}
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}

	private renderSkillInfo(skill: LoadedSkill): void {
		const lines: string[] = [`## Skill: ${skill.name}`, ""];
		lines.push(`**Description:** ${skill.description}`);
		lines.push("");
		lines.push(`**Source:** ${skill.sourceType}`);
		lines.push("");
		lines.push(`**Path:** \`${skill.sourcePath}\``);
		if (skill.resources.length > 0) {
			lines.push("");
			lines.push("**Resources:**");
			for (const resource of skill.resources.slice(0, 5)) {
				lines.push(`- \`${resource.path}\` (${resource.type})`);
			}
			if (skill.resources.length > 5) {
				lines.push(`- …and ${skill.resources.length - 5} more`);
			}
		}
		if (skill.content) {
			lines.push("");
			lines.push("**Instructions preview:**");
			lines.push("```");
			lines.push(formatPreviewBlock(skill.content, 200));
			lines.push("```");
		}
		this.callbacks.pushCommandOutput(lines.join("\n"));
	}

	// ─── Internal Helpers ──────────────────────────────────────────────────

	private injectSkillMessage(
		skill: LoadedSkill,
		action: "activate" | "deactivate",
	): void {
		this.deps.injectMessage(this.buildSkillMessage(skill, action));
	}

	private buildSkillMessage(
		skill: LoadedSkill,
		action: "activate" | "deactivate",
	): AppMessage {
		const content =
			action === "activate"
				? formatSkillForInjection(skill)
				: [
						`# Skill deactivated: ${skill.name}`,
						"",
						`Ignore previous instructions from the "${skill.name}" skill unless it is reactivated.`,
					].join("\n");
		return {
			role: "hookMessage",
			customType: action === "activate" ? "skill" : "skill-deactivated",
			content,
			display: false,
			details: { name: skill.name, action },
			timestamp: Date.now(),
		};
	}

	private hasMatchingSkillMessage(
		messages: AppMessage[],
		expected: AppMessage,
	): boolean {
		if (
			expected.role !== "hookMessage" ||
			expected.customType !== "skill" ||
			typeof expected.details !== "object" ||
			expected.details === null ||
			!("name" in expected.details) ||
			typeof expected.details.name !== "string"
		) {
			return false;
		}

		const expectedName = expected.details.name;
		const expectedContent = JSON.stringify(expected.content);
		for (const message of messages) {
			if (message.role !== "hookMessage" || message.customType !== "skill") {
				continue;
			}
			const details = message.details;
			if (
				typeof details === "object" &&
				details !== null &&
				"name" in details &&
				typeof details.name === "string" &&
				details.name === expectedName &&
				JSON.stringify(message.content) === expectedContent
			) {
				return true;
			}
		}
		return false;
	}

	private resolveSkillTarget(
		skills: LoadedSkill[],
		target: string,
		context: CommandExecutionContext,
	): LoadedSkill | null {
		let skill = findSkill(skills, target);
		if (!skill) {
			const matches = searchSkills(skills, target);
			if (matches.length === 1) {
				skill = matches[0];
			} else if (matches.length > 1) {
				const list = matches.map((match) => match.name).join(", ");
				context.showError(`Multiple skills match "${target}": ${list}`);
				return null;
			}
		}
		if (!skill) {
			context.showError(`Skill "${target}" not found.`);
			return null;
		}
		return skill;
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createSkillsController(
	options: SkillsControllerOptions,
): SkillsController {
	return new SkillsController(options);
}
