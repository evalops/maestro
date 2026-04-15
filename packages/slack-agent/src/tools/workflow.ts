/**
 * Workflow Tool - Multi-step workflow execution.
 *
 * Allows the agent to define and execute a sequence of steps,
 * with data flowing from one step to the next. Steps can include
 * connector queries, bash commands, and data transformations.
 *
 * This is a planning tool: the agent describes the steps, and the
 * workflow tool validates the plan and provides a structured execution log.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "./index.js";

const StepSchema = Type.Object({
	name: Type.String({ description: "Step name for reference" }),
	tool: Type.String({ description: "Tool name to call" }),
	args: Type.Unknown({
		description:
			"Arguments to pass to the tool (can reference previous step results via $steps.<name>)",
	}),
});

export function createWorkflowTool(availableTools: AgentTool[]): AgentTool {
	const toolMap = new Map(availableTools.map((t) => [t.name, t]));

	return {
		name: "workflow",
		label: "workflow",
		description:
			"Execute a multi-step workflow. Each step calls a tool and can reference " +
			"results from previous steps. Use for complex tasks that chain multiple " +
			"connector queries, bash commands, and data transformations.",
		parameters: Type.Object({
			label: Type.String({
				description: "Brief description of the workflow",
			}),
			steps: Type.Array(StepSchema, {
				description: "Ordered list of steps to execute",
				minItems: 1,
				maxItems: 10,
			}),
		}),
		execute: async (_toolCallId, args) => {
			const steps = args.steps as Array<{
				name: string;
				tool: string;
				args: unknown;
			}>;
			const results = new Map<string, unknown>();
			const log: string[] = [];

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i]!;
				const tool = toolMap.get(step.tool);

				if (!tool) {
					log.push(
						`Step ${i + 1}/${steps.length} [${step.name}]: FAILED - tool '${step.tool}' not found`,
					);
					return {
						content: [
							{
								type: "text" as const,
								text: log.join("\n"),
							},
						],
					};
				}

				const resolvedArgs = resolveStepReferences(
					(step.args ?? {}) as Record<string, unknown>,
					results,
				);

				log.push(
					`Step ${i + 1}/${steps.length} [${step.name}]: executing ${step.tool}...`,
				);

				try {
					const result = await tool.execute(
						`workflow-${_toolCallId}-step-${i}`,
						resolvedArgs,
					);
					const text = result.content
						.filter(
							(c): c is { type: string; text: string } =>
								c.type === "text" && !!c.text,
						)
						.map((c) => c.text)
						.join("\n");

					results.set(step.name, result.details ?? text);
					log.push(
						`Step ${i + 1}/${steps.length} [${step.name}]: OK (${text.length} chars)`,
					);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					log.push(
						`Step ${i + 1}/${steps.length} [${step.name}]: ERROR - ${msg}`,
					);
					results.set(step.name, { error: msg });
				}
			}

			const lastStep = steps[steps.length - 1]!;
			const finalResult = results.get(lastStep.name);

			log.push("", "Workflow complete.");

			return {
				content: [
					{
						type: "text" as const,
						text: log.join("\n"),
					},
				],
				details: {
					stepResults: Object.fromEntries(results),
					finalResult,
				},
			};
		},
	};
}

/**
 * Replace $steps.<name> references in args with actual results.
 */
function resolveStepReferences(
	args: Record<string, unknown>,
	results: Map<string, unknown>,
): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.startsWith("$steps.")) {
			const stepName = value.slice("$steps.".length);
			resolved[key] = results.get(stepName);
		} else if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			resolved[key] = resolveStepReferences(
				value as Record<string, unknown>,
				results,
			);
		} else {
			resolved[key] = value;
		}
	}

	return resolved;
}
