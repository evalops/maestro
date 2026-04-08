import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getProjectOnboardingState,
	markProjectOnboardingSeen,
} from "../../src/onboarding/project-onboarding.js";

describe("project onboarding", () => {
	let tempRoot: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-project-onboarding-"));
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("shows the workspace creation step for an effectively empty project", () => {
		const projectRoot = join(tempRoot, "empty-project");
		mkdirSync(join(projectRoot, ".maestro"), { recursive: true });

		const state = getProjectOnboardingState(projectRoot);

		expect(state.shouldShow).toBe(true);
		expect(state.completed).toBe(false);
		expect(state.seenCount).toBe(0);
		expect(state.steps).toEqual([
			{
				key: "workspace",
				text: "Ask Maestro to create a new app or clone a repository.",
				isComplete: false,
				isEnabled: true,
			},
			{
				key: "instructions",
				text: "Run /init to scaffold AGENTS.md instructions for this project.",
				isComplete: false,
				isEnabled: false,
			},
		]);
	});

	it("tracks seen counts for incomplete populated projects", () => {
		const projectRoot = join(tempRoot, "existing-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "package.json"), "{}");

		expect(getProjectOnboardingState(projectRoot).seenCount).toBe(0);

		markProjectOnboardingSeen(projectRoot);

		const state = getProjectOnboardingState(projectRoot);
		expect(state.shouldShow).toBe(true);
		expect(state.completed).toBe(false);
		expect(state.seenCount).toBe(1);
		expect(state.steps).toEqual([
			{
				key: "workspace",
				text: "Ask Maestro to create a new app or clone a repository.",
				isComplete: true,
				isEnabled: false,
			},
			{
				key: "instructions",
				text: "Run /init to scaffold AGENTS.md instructions for this project.",
				isComplete: false,
				isEnabled: true,
			},
		]);
	});

	it("treats CLAUDE.md as completing the instructions step", () => {
		const projectRoot = join(tempRoot, "documented-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "README.md"), "# Project");
		writeFileSync(join(projectRoot, "CLAUDE.md"), "# Instructions");

		const state = getProjectOnboardingState(projectRoot);

		expect(state.shouldShow).toBe(false);
		expect(state.completed).toBe(true);
		expect(state.steps[1]).toMatchObject({
			key: "instructions",
			isComplete: true,
			isEnabled: true,
		});
	});
});
