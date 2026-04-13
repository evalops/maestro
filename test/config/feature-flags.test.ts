import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAESTRO_EVALOPS_MANAGED_KILL_SWITCH,
	isFeatureFlagEnabled,
	resetFeatureFlagCacheForTests,
} from "../../src/config/feature-flags.js";

describe("feature flags", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		resetFeatureFlagCacheForTests();
	});

	it("returns false when no feature flag file is configured", () => {
		expect(isFeatureFlagEnabled(MAESTRO_EVALOPS_MANAGED_KILL_SWITCH)).toBe(
			false,
		);
	});

	it("reads the configured snapshot", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_EVALOPS_MANAGED_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isFeatureFlagEnabled(MAESTRO_EVALOPS_MANAGED_KILL_SWITCH)).toBe(
			true,
		);
	});
});
