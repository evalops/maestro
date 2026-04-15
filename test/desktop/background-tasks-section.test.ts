import { describe, expect, it } from "vitest";
import { buildBackgroundTasksViewModel } from "../../packages/desktop/src/renderer/components/Settings/BackgroundTasksSection";

describe("buildBackgroundTasksViewModel", () => {
	it("describes enabled background task settings", () => {
		const viewModel = buildBackgroundTasksViewModel({
			settings: {
				notificationsEnabled: true,
				statusDetailsEnabled: false,
			},
			snapshot: {
				running: 2,
				failed: 1,
				total: 5,
			},
		});

		expect(viewModel.notificationsEnabledLabel).toBe("On");
		expect(viewModel.statusDetailsEnabledLabel).toBe("Off");
		expect(viewModel.runningCount).toBe(2);
		expect(viewModel.failedCount).toBe(1);
		expect(viewModel.totalCount).toBe(5);
	});

	it("falls back to disabled and zero values when status is missing", () => {
		const viewModel = buildBackgroundTasksViewModel(null);

		expect(viewModel.notificationsEnabledLabel).toBe("Off");
		expect(viewModel.statusDetailsEnabledLabel).toBe("Off");
		expect(viewModel.runningCount).toBe(0);
		expect(viewModel.failedCount).toBe(0);
		expect(viewModel.totalCount).toBe(0);
	});

	it("handles missing snapshot counts", () => {
		const viewModel = buildBackgroundTasksViewModel({
			settings: {
				notificationsEnabled: false,
				statusDetailsEnabled: true,
			},
			snapshot: null,
		});

		expect(viewModel.notificationsEnabledLabel).toBe("Off");
		expect(viewModel.statusDetailsEnabledLabel).toBe("On");
		expect(viewModel.runningCount).toBe(0);
		expect(viewModel.failedCount).toBe(0);
		expect(viewModel.totalCount).toBe(0);
	});
});
