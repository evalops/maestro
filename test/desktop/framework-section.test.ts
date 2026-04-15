import { describe, expect, it } from "vitest";
import { buildFrameworkViewModel } from "../../packages/desktop/src/renderer/components/Settings/FrameworkSection";

describe("buildFrameworkViewModel", () => {
	it("prepends the none option and keeps the selected framework", () => {
		const viewModel = buildFrameworkViewModel(
			[
				{ id: "react", summary: "React" },
				{ id: "nextjs", summary: "Next.js" },
			],
			"nextjs",
			"workspace",
			false,
		);

		expect(viewModel.options).toEqual([
			{ id: "none", label: "None" },
			{ id: "react", label: "react" },
			{ id: "nextjs", label: "nextjs" },
		]);
		expect(viewModel.selectedFrameworkId).toBe("nextjs");
		expect(viewModel.isUserScopeSelected).toBe(false);
		expect(viewModel.isWorkspaceScopeSelected).toBe(true);
		expect(viewModel.isLocked).toBe(false);
		expect(viewModel.lockedMessage).toBeNull();
	});

	it("defaults to none when no frameworks are available", () => {
		const viewModel = buildFrameworkViewModel([], "none", "user", false);

		expect(viewModel.options).toEqual([{ id: "none", label: "None" }]);
		expect(viewModel.selectedFrameworkId).toBe("none");
		expect(viewModel.isUserScopeSelected).toBe(true);
		expect(viewModel.isWorkspaceScopeSelected).toBe(false);
	});

	it("shows the policy message when the framework is locked", () => {
		const viewModel = buildFrameworkViewModel(
			[{ id: "vue", summary: "Vue" }],
			"vue",
			"user",
			true,
		);

		expect(viewModel.isLocked).toBe(true);
		expect(viewModel.lockedMessage).toBe("Framework is locked by policy.");
	});
});
