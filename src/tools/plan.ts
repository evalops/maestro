import { z } from "zod";
import { createZodTool } from "./zod-tool.js";

const DEFAULT_STEPS = [
	"Clarify requirements and expected outcomes",
	"Review relevant code, dependencies, and context",
	"Implement the required changes in focused commits",
	"Exercise automated tests and perform manual spot checks",
	"Prepare summaries, documentation updates, and rollout notes",
];

const planSchema = z
	.object({
		goal: z
			.string({ description: "High level objective the plan should achieve" })
			.min(1, "Goal must not be empty"),
		tasks: z
			.array(
				z
					.string({ description: "Task description" })
					.min(1, "Task description must not be empty"),
				{ description: "Explicit tasks to include in the plan" },
			)
			.nonempty()
			.optional(),
		constraints: z
			.array(
				z
					.string({ description: "Constraint description" })
					.min(1, "Constraint must not be empty"),
				{ description: "Important constraints, risks, or notes" },
			)
			.optional(),
		includeTesting: z
			.boolean({ description: "Include a dedicated testing/verification step" })
			.optional(),
		includeReview: z
			.boolean({ description: "Include a review or rollout step" })
			.optional(),
	})
	.strict();

const ensureStepPresence = (
	steps: string[],
	include: boolean | undefined,
	label: string,
) => {
	if (!include) {
		return steps;
	}

	const hasLabel = steps.some((step) =>
		step.toLowerCase().includes(label.toLowerCase()),
	);
	return hasLabel ? steps : [...steps, label];
};

export const planTool = createZodTool({
	name: "plan",
	label: "plan",
	description:
		"Produce a lightweight execution plan for a coding objective, suitable for short to-do lists or standup summaries.",
	schema: planSchema,
	async execute(_toolCallId, params) {
		const {
			goal,
			tasks,
			constraints,
			includeTesting = true,
			includeReview = true,
		} = params;

		let steps = tasks && tasks.length > 0 ? [...tasks] : [...DEFAULT_STEPS];
		steps = ensureStepPresence(
			steps,
			includeTesting,
			"Verify changes with automated and manual testing",
		);
		steps = ensureStepPresence(
			steps,
			includeReview,
			"Share results, gather feedback, and finalize rollout",
		);

		const numberedSteps = steps.map((step, index) => `${index + 1}. ${step}`);

		const sections: string[] = [`Goal: ${goal}`];

		if (constraints?.length) {
			sections.push(
				`Constraints:
${constraints.map((item) => `- ${item}`).join("\n")}`,
			);
		}

		sections.push(
			`Plan:
${numberedSteps.join("\n")}`,
		);

		const text = sections.join("\n\n");

		return {
			content: [{ type: "text", text }],
			details: { steps: numberedSteps.length },
		};
	},
});
