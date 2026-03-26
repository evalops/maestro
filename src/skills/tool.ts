/**
 * Skill Tool - Allows the agent to load specialized domain skills.
 *
 * This tool enables the agent to dynamically load skill instructions
 * and resources when it recognizes a task that matches a skill's domain.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";
import {
	type LoadedSkill,
	findSkill,
	formatSkillForInjection,
	formatSkillListItem,
	loadSkills,
	searchSkills,
} from "./loader.js";

const logger = createLogger("skills:tool");

/**
 * Skill tool input schema.
 */
const SkillToolSchema = Type.Object({
	skill: Type.String({
		description:
			'The name of the skill to load. Use "list" to see all available skills, or a search term to find matching skills.',
	}),
	args: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional arguments to pass to the skill",
		}),
	),
});

/**
 * Create the Skill tool definition.
 */
export function createSkillTool(
	workspaceDir: string,
	options?: { includeSystem?: boolean },
): AgentTool {
	// Load skills once when tool is created
	let cachedSkills: LoadedSkill[] | null = null;

	const getSkills = (): LoadedSkill[] => {
		if (cachedSkills === null) {
			const result = loadSkills(workspaceDir, options);
			cachedSkills = result.skills;
		}
		return cachedSkills;
	};

	return {
		name: "Skill",
		label: "Skill",
		description: `Load a specialized skill that provides domain-specific instructions and workflows.

When you recognize that a task matches one of the available skills, use this tool to load the full skill instructions. The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.

Use this tool proactively when:
- The user asks about a domain that matches an available skill
- You need specialized procedures or workflows
- You want access to skill-specific resources

Available skills can be listed by calling this tool with skill="list".`,
		parameters: SkillToolSchema,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
		): Promise<AgentToolResult> => {
			const skillName = (params.skill as string)?.trim() ?? "";
			const args = params.args as Record<string, string> | undefined;

			if (!skillName) {
				return {
					content: [{ type: "text", text: "Error: skill name is required" }],
					isError: true,
				};
			}

			const skills = getSkills();

			// Handle "list" command
			if (skillName.toLowerCase() === "list") {
				if (skills.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No skills available. Skills can be added to `.maestro/skills/` in your workspace or `~/.maestro/skills/` for global skills.",
							},
						],
					};
				}

				const lines = [
					`Available Skills (${skills.length}):`,
					"",
					...skills.map((s) => `- ${formatSkillListItem(s)}`),
					"",
					"Use Skill tool with the skill name to load its instructions.",
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
				};
			}

			// Try to find exact match first
			let skill = findSkill(skills, skillName);

			// If no exact match, try search
			if (!skill) {
				const matches = searchSkills(skills, skillName);
				if (matches.length === 1) {
					skill = matches[0];
				} else if (matches.length > 1) {
					const lines = [
						`Multiple skills match "${skillName}":`,
						"",
						...matches.map((s) => `- ${formatSkillListItem(s)}`),
						"",
						"Please specify the exact skill name.",
					];

					return {
						content: [{ type: "text", text: lines.join("\n") }],
					};
				}
			}

			if (!skill) {
				const suggestions =
					skills.length > 0
						? `\n\nAvailable skills: ${skills.map((s) => s.name).join(", ")}`
						: '\n\nNo skills are available. Add skills to `.maestro/skills/` or use "list" to check.';

				return {
					content: [
						{
							type: "text",
							text: `Skill "${skillName}" not found.${suggestions}`,
						},
					],
					isError: true,
				};
			}

			logger.info("Loading skill", {
				name: skill.name,
				sourceType: skill.sourceType,
			});

			// Format skill content for injection
			let text = formatSkillForInjection(skill);

			// Handle args substitution if provided
			if (args && Object.keys(args).length > 0) {
				for (const [key, value] of Object.entries(args)) {
					const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
					text = text.replace(pattern, value);
				}
			}

			return {
				content: [{ type: "text", text }],
			};
		},
	};
}

/**
 * Invalidate cached skills (call after skill files change).
 */
export function invalidateSkillCache(): void {
	// This would need to be connected to the actual tool instance
	// For now, skills are loaded fresh each time createSkillTool is called
	logger.debug("Skill cache invalidation requested");
}
