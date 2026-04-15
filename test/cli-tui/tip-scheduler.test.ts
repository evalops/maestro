import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LoaderTipDefinition,
	getLoaderTip,
	resetLoaderTipSchedulerForTests,
	selectTipWithLongestTimeSinceShown,
} from "../../src/cli-tui/tips/tip-scheduler.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(tempDir);
	return tempDir;
}

afterEach(() => {
	resetLoaderTipSchedulerForTests();
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("tip scheduler", () => {
	it("prefers the tip that has been unseen for the longest and keeps registry order on ties", () => {
		const tips: LoaderTipDefinition[] = [
			{
				id: "first",
				content: "First tip",
				cooldownSessions: 1,
				isRelevant: () => true,
			},
			{
				id: "second",
				content: "Second tip",
				cooldownSessions: 1,
				isRelevant: () => true,
			},
		];

		expect(
			selectTipWithLongestTimeSinceShown(
				tips,
				{
					version: 1,
					launchCount: 12,
					lastShownLaunchByTip: {
						first: 11,
						second: 4,
					},
				},
				12,
			)?.id,
		).toBe("second");

		expect(
			selectTipWithLongestTimeSinceShown(
				tips,
				{
					version: 1,
					launchCount: 12,
					lastShownLaunchByTip: {},
				},
				12,
			)?.id,
		).toBe("first");
	});

	it("surfaces the /init onboarding tip for non-empty workspaces without instructions", () => {
		const projectRoot = createTempDir("maestro-tip-project-");
		const keybindingsDir = createTempDir("maestro-tip-keybindings-");
		const historyDir = createTempDir("maestro-tip-history-");
		const onboardingDir = createTempDir("maestro-tip-onboarding-");
		const keybindingsPath = join(keybindingsDir, "keybindings.json");

		writeFileSync(
			join(projectRoot, "package.json"),
			'{"name":"demo"}',
			"utf-8",
		);
		writeFileSync(
			keybindingsPath,
			JSON.stringify({ version: 1, bindings: {} }),
			"utf-8",
		);

		vi.stubEnv(
			"MAESTRO_PROJECT_ONBOARDING_FILE",
			join(onboardingDir, "project-onboarding.json"),
		);
		vi.stubEnv("MAESTRO_KEYBINDINGS_FILE", keybindingsPath);
		vi.stubEnv(
			"MAESTRO_TUI_TIP_HISTORY_FILE",
			join(historyDir, "tips-history.json"),
		);

		expect(getLoaderTip({ projectRoot })).toBe(
			"Run /init to scaffold AGENTS.md instructions for this project.",
		);
	});

	it("does not repeat the same tip twice in one launch", () => {
		const projectRoot = createTempDir("maestro-tip-repeat-project-");
		const keybindingsDir = createTempDir("maestro-tip-repeat-keybindings-");
		const historyDir = createTempDir("maestro-tip-repeat-history-");
		const onboardingDir = createTempDir("maestro-tip-repeat-onboarding-");
		const keybindingsPath = join(keybindingsDir, "keybindings.json");

		writeFileSync(
			join(projectRoot, "package.json"),
			'{"name":"demo"}',
			"utf-8",
		);
		writeFileSync(
			join(projectRoot, "AGENTS.md"),
			"# Project context\n",
			"utf-8",
		);
		writeFileSync(
			keybindingsPath,
			JSON.stringify({ version: 1, bindings: {} }),
			"utf-8",
		);

		vi.stubEnv(
			"MAESTRO_PROJECT_ONBOARDING_FILE",
			join(onboardingDir, "project-onboarding.json"),
		);
		vi.stubEnv("MAESTRO_KEYBINDINGS_FILE", keybindingsPath);
		vi.stubEnv(
			"MAESTRO_TUI_TIP_HISTORY_FILE",
			join(historyDir, "tips-history.json"),
		);

		const firstTip = getLoaderTip({ projectRoot });
		const secondTip = getLoaderTip({ projectRoot });

		expect(firstTip).toBeTruthy();
		expect(secondTip).toBeTruthy();
		expect(secondTip).not.toBe(firstTip);
	});
});
