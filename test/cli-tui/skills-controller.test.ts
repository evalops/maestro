import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMessage } from "../../src/agent/types.js";
import { SkillsController } from "../../src/cli-tui/tui-renderer/skills-controller.js";
import type { LoadedSkill } from "../../src/skills/loader.js";
import { loadSkills } from "../../src/skills/loader.js";

vi.mock("../../src/skills/loader.js", () => ({
	loadSkills: vi.fn(),
	findSkill: vi.fn(
		(skills: LoadedSkill[], target: string) =>
			skills.find((skill) => skill.name === target) ?? null,
	),
	searchSkills: vi.fn(() => []),
	formatSkillForInjection: vi.fn(
		(skill: LoadedSkill) => `Injected instructions for ${skill.name}`,
	),
	formatSkillListItem: vi.fn((skill: LoadedSkill) => skill.name),
}));

function createSkill(name: string): LoadedSkill {
	return {
		name,
		description: `${name} description`,
		sourcePath: `/tmp/${name}`,
		sourceType: "project",
		content: `# ${name}\nDo the thing.`,
		resources: [],
		resourceDirs: {},
	};
}

function createCommandContext(argumentText: string) {
	return {
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	} as never;
}

describe("SkillsController", () => {
	beforeEach(() => {
		vi.mocked(loadSkills).mockReset();
	});

	it("reinjects active skill instructions after compaction when they were summarized away", () => {
		const skill = createSkill("debug");
		vi.mocked(loadSkills).mockReturnValue({ skills: [skill], errors: [] });

		let currentMessages: AppMessage[] = [];
		const injectMessage = vi.fn((message: AppMessage) => {
			currentMessages = [...currentMessages, message];
		});

		const controller = new SkillsController({
			deps: {
				injectMessage,
				getMessages: () => currentMessages,
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput: vi.fn(),
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});

		controller.handleSkillsCommand(createCommandContext("activate debug"));
		currentMessages = [];
		injectMessage.mockClear();

		const restored = controller.restoreActiveSkillsAfterCompaction();

		expect(restored).toBe(1);
		expect(injectMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				details: { name: "debug", action: "activate" },
			}),
		);
	});

	it("collects active skill restoration messages for ordered compaction replay", () => {
		const skill = createSkill("debug");
		vi.mocked(loadSkills).mockReturnValue({ skills: [skill], errors: [] });

		let currentMessages: AppMessage[] = [];
		const controller = new SkillsController({
			deps: {
				injectMessage: vi.fn((message: AppMessage) => {
					currentMessages = [...currentMessages, message];
				}),
				getMessages: () => currentMessages,
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput: vi.fn(),
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});

		controller.handleSkillsCommand(createCommandContext("activate debug"));
		currentMessages = [];

		expect(controller.collectActiveSkillMessagesForCompaction()).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				details: { name: "debug", action: "activate" },
			}),
		]);
	});

	it("re-restores active skills when only older compaction history contains the prior hook", () => {
		const skill = createSkill("debug");
		vi.mocked(loadSkills).mockReturnValue({ skills: [skill], errors: [] });

		let currentMessages: AppMessage[] = [];
		const controller = new SkillsController({
			deps: {
				injectMessage: vi.fn((message: AppMessage) => {
					currentMessages = [...currentMessages, message];
				}),
				getMessages: () => currentMessages,
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput: vi.fn(),
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});

		controller.handleSkillsCommand(createCommandContext("activate debug"));
		expect(currentMessages).toHaveLength(1);

		expect(controller.collectActiveSkillMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				details: { name: "debug", action: "activate" },
			}),
		]);
	});

	it("skips reinjection when the compacted tail already preserved the active skill message", () => {
		const skill = createSkill("debug");
		vi.mocked(loadSkills).mockReturnValue({ skills: [skill], errors: [] });

		let currentMessages: AppMessage[] = [];
		const injectMessage = vi.fn((message: AppMessage) => {
			currentMessages = [...currentMessages, message];
		});

		const controller = new SkillsController({
			deps: {
				injectMessage,
				getMessages: () => currentMessages,
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput: vi.fn(),
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});

		controller.handleSkillsCommand(createCommandContext("activate debug"));
		injectMessage.mockClear();

		const restored = controller.restoreActiveSkillsAfterCompaction();

		expect(restored).toBe(0);
		expect(injectMessage).not.toHaveBeenCalled();
	});
});
