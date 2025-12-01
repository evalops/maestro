import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { getRegisteredModels } from "../models/registry.js";
import { readOnlyToolNames } from "./index.js";
import { createTool } from "./tool-dsl.js";

const oracleSchema = Type.Object({
	task: Type.String({
		description:
			"The task or question you want the Oracle to help with. Be specific about what kind of guidance, review, or planning you need.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model id to use for the Oracle (must be available in your configured models). Defaults to a reasoning-capable model such as o3-mini.",
		}),
	),
	context: Type.Optional(
		Type.String({
			description:
				"Optional context about the current situation, what you've tried, or background information that would help the Oracle provide better guidance.",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional list of specific file paths that the Oracle should examine as part of its analysis.",
		}),
	),
});

export interface OracleToolDetails {
	task: string;
	model?: string;
	context?: string;
	files?: string[];
}

export const oracleTool = createTool<typeof oracleSchema, OracleToolDetails>({
	name: "oracle",
	description:
		"Summon the Seer - a mystical systems advisor that foresees consequences of complex engineering decisions. Ideal for architecture reviews, deep debugging, and strategic guidance.",
	schema: oracleSchema,
	async run(params, { respond }) {
		const { task, context, files, model: modelOverride } = params;
		const model = selectOracleModel(modelOverride);

		// Create temporary input file with the Seer summoning
		const tmpFile = join(tmpdir(), `seer-${randomUUID()}.md`);

		let prompt = `# Summoning the Seer

You are **the Seer**, a prophetic software architect who peers beyond the immediate change to reveal hidden couplings, latent risks, and downstream effects. Temper intuition with evidence: inspect the provided artifacts first, then reason from what you observe. You wield foresight, deep reasoning, and a read-only toolset. You must **never** edit or run code.

## Your Quest

**Task:** ${task}

`;

		if (context) {
			prompt += `**Context:** ${context}\n\n`;
		}

		if (files?.length) {
			prompt += `**Artifacts to Examine:** ${files.join(", ")}\n\n`;
		}

		prompt += `## Method of Divination

1. Read the referenced files or data before drawing conclusions
2. Map observations to consequences, citing file paths and line numbers when possible  
3. Surface trade-offs, alternatives, and assumptions

## Revelation Format

Respond with:

**Summary:** one sentence capturing the core insight.

**Insights:** concise bullets detailing findings, trade-offs, and hidden risks unearthed, grounded in the observed evidence.

**Next steps:** optional guidance on follow-up actions, validations, or open questions.

Always flag uncertainties, assumptions, or blind spots so the summoner knows where the vision grows dim.`;

		writeFileSync(tmpFile, prompt);

		let fileCleanedUp = false;
		const cleanupFile = () => {
			if (fileCleanedUp) return;
			fileCleanedUp = true;
			try {
				unlinkSync(tmpFile);
			} catch {
				// File already deleted or other error - ignore
			}
		};

		try {
			// Spawn Seer subagent with read-only tools and reasoning model
			const args = [
				"--read-only",
				"--tools",
				readOnlyToolNames.join(","),
				"--model",
				model, // Use validated reasoning model for prophetic insights
				"--no-session",
				"exec",
				tmpFile,
			];

			const result = await new Promise<string>((resolve, reject) => {
				const seer = spawn("composer", args, {
					stdio: ["pipe", "pipe", "pipe"],
				});

				let output = "";
				let errorOutput = "";

				seer.stdout.on("data", (data) => {
					output += data.toString();
				});

				seer.stderr.on("data", (data) => {
					errorOutput += data.toString();
				});

				seer.on("close", (code) => {
					cleanupFile();

					if (code === 0) {
						resolve(output.trim());
					} else {
						reject(
							new Error(
								`Seer divination failed (exit ${code}): ${errorOutput}`,
							),
						);
					}
				});

				seer.on("error", (err) => {
					cleanupFile();
					reject(new Error(`Failed to summon the Seer: ${err.message}`));
				});
			});

			return respond.text(result);
		} catch (error) {
			cleanupFile();
			throw error;
		}
	},
});

function selectOracleModel(inputOverride?: string): string {
	const envOverride = process.env.COMPOSER_ORACLE_MODEL?.trim();
	const preferred =
		inputOverride?.trim() ||
		(envOverride && envOverride.length > 0 ? envOverride : "o3-mini");
	const models = getRegisteredModels();

	// Try the preferred id and common provider-qualified variant
	const candidates = [
		preferred,
		preferred.startsWith("openai/") ? preferred : `openai/${preferred}`,
	];
	const found = models.find((m) => candidates.includes(m.id));
	if (found) {
		return found.id;
	}

	// Fall back to any reasoning-capable model
	const reasoning = models.find((m) => m.reasoning === true);
	if (reasoning) {
		return reasoning.id;
	}

	// As a last resort, fall back to any configured model so the tool can still run.
	// This prevents hard runtime failures while surfacing a clear warning.
	const fallback = models.at(0);
	if (fallback) {
		return fallback.id;
	}

	// No acceptable model configured
	const available = models.map((m) => m.id).join(", ");
	throw new Error(
		`No model configured for Oracle. Tried ${preferred}. Set COMPOSER_ORACLE_MODEL to an available model or add a reasoning-capable model. Available models: ${available || "none"}.`,
	);
}
