import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH,
	MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG,
	MAESTRO_EVALOPS_MANAGED_KILL_SWITCH,
	MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
	MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH,
	MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
	areAutonomousActionsDisabled,
	isDraftAndConfirmDefaultEnabled,
	isFeatureFlagEnabled,
	isPlatformRuntimeBridgeDisabled,
	isPlatformRuntimeObserveEnabled,
	isPlatformToolExecutionBridgeEnabled,
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

	it("detects the autonomous actions kill switch", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(areAutonomousActionsDisabled()).toBe(true);
	});

	it("detects the draft-and-confirm default flag", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isDraftAndConfirmDefaultEnabled()).toBe(true);
	});

	it("detects the platform runtime observe and tool execution bridge flags", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
						enabled: true,
					},
					{
						key: MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isPlatformRuntimeObserveEnabled()).toBe(true);
		expect(isPlatformToolExecutionBridgeEnabled()).toBe(true);
	});

	it("detects the platform runtime bridge kill switch", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isPlatformRuntimeBridgeDisabled()).toBe(true);
	});
});
