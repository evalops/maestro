import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DelegationPrompt, formatDelegation } from "@evalops/contracts";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { getRegisteredModels } from "../models/registry.js";
import {
	buildEvalOpsDelegationEnvironment,
	issueEvalOpsDelegationToken,
} from "../oauth/index.js";
import { createTool } from "./tool-dsl.js";
import { readOnlyToolNames } from "./tool-names.js";

const ORACLE_TIMEOUT_MS = 120_000;

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
	async run(params, { respond, signal, toolCallId }) {
		const { task, context, files, model: modelOverride } = params;
		const model = selectOracleModel(modelOverride);

		// Create temporary input file with the Seer summoning
		const tmpFile = join(tmpdir(), `seer-${randomUUID()}.md`);

		const delegationPrompt: DelegationPrompt = {
			goal: "Provide read-only architectural guidance for a complex engineering decision.",
			context:
				context ??
				"The caller did not provide extra context beyond the task and artifacts.",
			task,
			evidence: files?.length
				? files.map((file) => `Artifact to examine: ${file}`)
				: [],
			validation:
				"Inspect referenced artifacts before drawing conclusions, cite file paths and line numbers when possible, and separate evidence from assumptions.",
			stoppingCondition:
				"Stop after a concise response with Summary, Insights, optional Next steps, and any uncertainties. Never edit or run code.",
		};
		const prompt = [
			"You are the Seer, a read-only software architecture advisor. You must never edit or run code.",
			"",
			formatDelegation(delegationPrompt),
		].join("\n");

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
			const env = await buildOracleEnv(toolCallId);

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
				if (signal?.aborted) {
					cleanupFile();
					reject(new Error("Seer invocation aborted"));
					return;
				}

				const seer = spawn("maestro", args, {
					env,
					stdio: ["pipe", "pipe", "pipe"],
				});

				let output = "";
				let errorOutput = "";
				let timedOut = false;
				let aborted = false;
				let timeoutHandle: NodeJS.Timeout | null = null;

				const killChild = () => {
					if (seer.pid) {
						try {
							process.kill(seer.pid);
						} catch {
							// Already terminated
						}
					}
				};

				const cleanupListeners = () => {
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
					}
					signal?.removeEventListener("abort", onAbort);
				};

				const onAbort = () => {
					aborted = true;
					killChild();
				};

				if (signal) {
					signal.addEventListener("abort", onAbort);
				}

				const startTimeout = () => {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killChild();
					}, ORACLE_TIMEOUT_MS);
				};

				startTimeout();

				seer.stdout.on("data", (data) => {
					output += data.toString();
				});

				seer.stderr.on("data", (data) => {
					errorOutput += data.toString();
				});

				seer.on("close", (code) => {
					cleanupFile();
					cleanupListeners();

					if (code === 0 && !timedOut && !aborted) {
						resolve(output.trim());
					} else {
						reject(
							new Error(
								aborted
									? "Seer invocation aborted"
									: timedOut
										? "Seer divination timed out"
										: `Seer divination failed (exit ${code}): ${errorOutput}`,
							),
						);
					}
				});

				seer.on("error", (err) => {
					cleanupFile();
					cleanupListeners();
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

async function buildOracleEnv(
	toolCallId: string,
): Promise<Record<string, string | undefined>> {
	const baseEnv = { ...process.env };

	try {
		const delegation = await issueEvalOpsDelegationToken({
			agentId: toolCallId,
			agentType: "oracle_seer",
			capabilities: ["oracle_read_only"],
			runId: toolCallId,
			surface: "maestro-oracle",
			token: process.env.MAESTRO_EVALOPS_ACCESS_TOKEN,
			ttlSeconds: Math.max(60, Math.ceil(ORACLE_TIMEOUT_MS / 1000)),
		});

		return {
			...baseEnv,
			...buildEvalOpsDelegationEnvironment(delegation),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("Run /login evalops first") ||
			message.includes("EvalOps login requires")
		) {
			return baseEnv;
		}

		return baseEnv;
	}
}

function selectOracleModel(inputOverride?: string): string {
	const envOverride = process.env.MAESTRO_ORACLE_MODEL?.trim();
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
		`No model configured for Oracle. Tried ${preferred}. Set MAESTRO_ORACLE_MODEL to an available model or add a reasoning-capable model. Available models: ${available || "none"}.`,
	);
}
