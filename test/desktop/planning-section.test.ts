import { describe, expect, it } from "vitest";
import { buildPlanningViewModel } from "../../packages/desktop/src/renderer/components/Settings/PlanningSection";

describe("buildPlanningViewModel", () => {
	it("describes inactive plan mode", () => {
		const viewModel = buildPlanningViewModel(null, false);

		expect(viewModel.isActive).toBe(false);
		expect(viewModel.actionLabel).toBe("Start plan");
		expect(viewModel.showNameInput).toBe(true);
		expect(viewModel.showEditor).toBe(false);
		expect(viewModel.saveDisabled).toBe(true);
	});

	it("describes an active plan with a file path", () => {
		const viewModel = buildPlanningViewModel(
			{
				state: {
					active: true,
					filePath: "/tmp/feature-rollout.md",
					name: "Feature rollout",
				},
				content: "- [ ] ship it",
			},
			false,
		);

		expect(viewModel.isActive).toBe(true);
		expect(viewModel.actionLabel).toBe("Exit plan");
		expect(viewModel.showNameInput).toBe(false);
		expect(viewModel.showEditor).toBe(true);
		expect(viewModel.planFileLabel).toBe("/tmp/feature-rollout.md");
		expect(viewModel.saveDisabled).toBe(true);
	});

	it("falls back when the plan file has not been created yet", () => {
		const viewModel = buildPlanningViewModel(
			{
				state: {
					active: true,
					filePath: "",
				},
				content: "",
			},
			false,
		);

		expect(viewModel.planFileLabel).toBe("Plan file not created yet");
	});

	it("enables saving only when the draft is dirty", () => {
		const cleanViewModel = buildPlanningViewModel(
			{
				state: {
					active: true,
					filePath: "/tmp/plan.md",
				},
				content: "- [ ] write tests",
			},
			false,
		);
		const dirtyViewModel = buildPlanningViewModel(
			{
				state: {
					active: true,
					filePath: "/tmp/plan.md",
				},
				content: "- [ ] write tests",
			},
			true,
		);

		expect(cleanViewModel.saveDisabled).toBe(true);
		expect(dirtyViewModel.saveDisabled).toBe(false);
	});
});
