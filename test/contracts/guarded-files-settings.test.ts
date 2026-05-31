import { describe, expect, it } from "vitest";
import {
	DEFAULT_GUARDED_FILE_PATTERNS,
	normalizeGuardedFilesSettings,
} from "../../packages/contracts/src/guarded-files-settings.js";

describe("guarded files settings contract", () => {
	it("exports stable default policy keys for every guarded category", () => {
		expect(DEFAULT_GUARDED_FILE_PATTERNS.map((pattern) => pattern.key)).toEqual(
			[
				"cursor-config",
				"windsurf-config",
				"antigravity-config",
				"jetbrains-app-config",
				"jetbrains-project-config",
				"neovim-config",
				"amp-settings",
				"shell-config",
				"ssh-gpg-keys",
			],
		);
		expect(
			new Set(DEFAULT_GUARDED_FILE_PATTERNS.map((pattern) => pattern.key)).size,
		).toBe(DEFAULT_GUARDED_FILE_PATTERNS.length);
	});

	it("normalizes optional admin settings into deduped valid lists", () => {
		expect(
			normalizeGuardedFilesSettings({
				allowlist: [
					"repo-safe",
					"",
					"repo-safe",
					" workspace-docs ",
					1 as never,
				],
				mandatoryKeys: ["ssh-gpg-keys", "", "ssh-gpg-keys", false as never],
				rules: [
					{
						key: " custom-secrets ",
						description: " Custom secrets ",
						patterns: ["**/.secrets/**", 7 as never],
						reason: " Custom reason ",
						defaultBehavior: "block",
					},
					{
						key: "fallback-description",
						description: 1 as never,
						patterns: [" **/.fallback/** "],
						defaultBehavior: "invalid" as never,
					},
					{
						key: 42 as never,
						description: "Missing key",
						patterns: ["**/.missing-key/**"],
						defaultBehavior: "ask",
					},
					{
						key: "missing-patterns",
						description: "Missing patterns",
						patterns: [],
						defaultBehavior: "ask",
					},
					{
						key: "malformed-patterns",
						description: "Malformed patterns",
						patterns: undefined,
						defaultBehavior: "ask",
					} as never,
					null as never,
				],
			}),
		).toEqual({
			allowlist: ["repo-safe", "workspace-docs"],
			mandatoryKeys: ["ssh-gpg-keys"],
			rules: [
				{
					key: "custom-secrets",
					description: "Custom secrets",
					patterns: ["**/.secrets/**"],
					reason: "Custom reason",
					defaultBehavior: "block",
				},
				{
					key: "fallback-description",
					description: "fallback-description",
					patterns: ["**/.fallback/**"],
					defaultBehavior: "ask",
				},
			],
		});
	});
});
