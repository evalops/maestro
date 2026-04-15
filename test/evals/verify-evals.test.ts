import { describe, expect, it } from "vitest";
import {
	loadEvalConfiguration,
	validateEvalConfiguration,
} from "../../scripts/verify-evals.js";

describe("verify evals configuration", () => {
	it("accepts the current deterministic eval and live entrypoint config", () => {
		const failures = validateEvalConfiguration(loadEvalConfiguration());

		expect(failures).toEqual([]);
	});

	it("fails when a live eval package script is removed", () => {
		const config = loadEvalConfiguration();
		delete config.packageJson.scripts["evals:openrouter-live-smoke"];

		const failures = validateEvalConfiguration(config);

		expect(failures).toContain(
			"Missing package.json script: evals:openrouter-live-smoke",
		);
	});
});
