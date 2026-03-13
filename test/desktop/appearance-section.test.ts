import { describe, expect, it } from "vitest";
import { buildAppearanceViewModel } from "../../packages/desktop/src/renderer/components/Settings/AppearanceSection";

describe("buildAppearanceViewModel", () => {
	it("summarizes dark comfortable settings", () => {
		const viewModel = buildAppearanceViewModel("dark", true, "comfortable");

		expect(viewModel.themeMode).toBe("dark");
		expect(viewModel.showTimestampsLabel).toBe("On");
		expect(viewModel.isComfortableSelected).toBe(true);
		expect(viewModel.isCompactSelected).toBe(false);
	});

	it("summarizes system compact settings", () => {
		const viewModel = buildAppearanceViewModel("system", false, "compact");

		expect(viewModel.themeMode).toBe("system");
		expect(viewModel.showTimestampsLabel).toBe("Off");
		expect(viewModel.isComfortableSelected).toBe(false);
		expect(viewModel.isCompactSelected).toBe(true);
	});
});
