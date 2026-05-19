import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telemetryMocks = vi.hoisted(() => ({
	recordStagedRolloutSurfaceUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/telemetry.js", () => telemetryMocks);

import { handleModesCommand } from "../../src/cli/commands/modes.js";

describe("modes command", () => {
	const originalLog = console.log;
	const originalError = console.error;
	let output: string[];

	beforeEach(() => {
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		console.error = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		telemetryMocks.recordStagedRolloutSurfaceUsage.mockClear();
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalError;
	});

	it("records staged rollout usage when describing hidden modes", async () => {
		await handleModesCommand("describe", ["frontier"], {
			provider: "openai",
			json: true,
		});

		expect(telemetryMocks.recordStagedRolloutSurfaceUsage).toHaveBeenCalledWith(
			"hidden_mode_used",
			expect.objectContaining({
				surfaceId: "mode:frontier",
				surfaceType: "mode",
				owner: "agent-runtime",
				source: "cli:modes:describe",
			}),
		);
		expect(JSON.parse(output.join("\n"))).toMatchObject({
			mode: "frontier",
			visible: false,
		});
	});

	it("does not record staged rollout usage for visible modes", async () => {
		await handleModesCommand("describe", ["smart"]);

		expect(
			telemetryMocks.recordStagedRolloutSurfaceUsage,
		).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("Mode: Smart (smart)");
	});
});
