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

function createSkill(
	name: string,
	overrides: Partial<LoadedSkill> = {},
): LoadedSkill {
	return {
		name,
		description: `${name} description`,
		sourcePath: `/tmp/${name}`,
		sourceType: "project",
		content: `# ${name}\nDo the thing.`,
		resources: [],
		resourceDirs: {},
		contentSha: "a".repeat(64),
		...overrides,
	} as LoadedSkill;
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

	it("refreshes active skill instructions when the kept tail preserved a stale skill message", () => {
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

		expect(
			controller.collectActiveSkillMessagesForCompaction([
				{
					role: "hookMessage",
					customType: "skill",
					content: "Injected instructions for debug (stale)",
					display: false,
					details: { name: "debug", action: "activate" },
					timestamp: Date.now(),
				},
			]),
		).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: "skill",
				content: "Injected instructions for debug",
				details: { name: "debug", action: "activate" },
			}),
		]);
	});
});

describe("SkillsController /skills trust (#2629)", () => {
	let resetTrustCacheForTests: () => void;
	let listApprovedSkillsForTests: () => Array<{ contentSha: string }>;

	beforeEach(async () => {
		// Need a clean trust cache between tests; pin MAESTRO_HOME to
		// a temp dir so the cache file doesn't bleed into the dev's
		// real ~/.maestro.
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.MAESTRO_HOME = mkdtempSync(
			join(tmpdir(), "maestro-skills-trust-test-"),
		);
		const tc = await import("../../src/skills/trust-cache.js");
		resetTrustCacheForTests = tc.resetTrustCacheForTests;
		listApprovedSkillsForTests = tc.listApprovedSkillsForTests;
		resetTrustCacheForTests();
	});

	function buildController(skills: LoadedSkill[]) {
		vi.mocked(loadSkills).mockReturnValue({ skills, errors: [] });
		const pushCommandOutput = vi.fn();
		const controller = new SkillsController({
			deps: {
				injectMessage: vi.fn(),
				getMessages: () => [],
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput,
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});
		return { controller, pushCommandOutput };
	}

	function run(controller: SkillsController, argumentText: string) {
		// Build a fresh context per call so we can inspect what the
		// command did (the controller routes user-visible messages
		// through the context, not the callbacks).
		const showInfo = vi.fn();
		const showError = vi.fn();
		const ctx = {
			argumentText,
			showInfo,
			showError,
			renderHelp: vi.fn(),
		} as never;
		controller.handleSkillsCommand(ctx);
		return { showInfo, showError };
	}

	it("list shows unapproved status for project skills with no approval", () => {
		const { controller, pushCommandOutput } = buildController([
			createSkill("review", {
				sourceType: "project",
				contentSha: "1".repeat(64),
			}),
		]);
		run(controller, "trust");
		const out = pushCommandOutput.mock.calls[0]?.[0] as string;
		expect(out).toContain("review");
		expect(out).toContain("unapproved");
		expect(out).toContain("`sha=111111111111`");
	});

	it("approve records the SHA and updates list to approved", () => {
		const sha = "2".repeat(64);
		const { controller, pushCommandOutput } = buildController([
			createSkill("review", { sourceType: "project", contentSha: sha }),
		]);

		const { showInfo } = run(controller, "trust approve review");
		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Approved skill"),
		);
		expect(listApprovedSkillsForTests().map((e) => e.contentSha)).toContain(
			sha,
		);

		run(controller, "trust list");
		const out = pushCommandOutput.mock.calls.at(-1)?.[0] as string;
		expect(out).toContain("approved");
	});

	it("revoke drops the approval and list flips back to unapproved", () => {
		const sha = "3".repeat(64);
		const { controller, pushCommandOutput } = buildController([
			createSkill("review", { sourceType: "project", contentSha: sha }),
		]);

		run(controller, "trust approve review");
		const { showInfo } = run(controller, "trust revoke review");
		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Revoked approval"),
		);

		run(controller, "trust list");
		const out = pushCommandOutput.mock.calls.at(-1)?.[0] as string;
		expect(out).toContain("unapproved");
	});

	it("approve is idempotent — duplicate approve says already approved", () => {
		const sha = "4".repeat(64);
		const { controller } = buildController([
			createSkill("review", { sourceType: "project", contentSha: sha }),
		]);
		run(controller, "trust approve review");
		const { showInfo } = run(controller, "trust approve review");
		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("already approved"),
		);
	});

	it("approve does nothing for built-in (system) skills — they are always trusted", () => {
		const { controller } = buildController([
			createSkill("system-skill", {
				sourceType: "system",
				contentSha: "5".repeat(64),
			}),
		]);
		const { showInfo } = run(controller, "trust approve system-skill");
		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("approval not required"),
		);
		expect(listApprovedSkillsForTests()).toHaveLength(0);
	});

	it("status shows a single skill's approval state in detail", () => {
		const sha = "6".repeat(64);
		const { controller, pushCommandOutput } = buildController([
			createSkill("review", { sourceType: "project", contentSha: sha }),
		]);
		run(controller, "trust status review");
		const out = pushCommandOutput.mock.calls[0]?.[0] as string;
		expect(out).toContain("Trust status — review");
		expect(out).toContain("Source: project");
		expect(out).toContain(`Prompt SHA: \`${sha}\``);
		expect(out).toContain("unapproved");
	});

	it("approve without a name shows a usage error", () => {
		const { controller } = buildController([createSkill("review")]);
		const { showError } = run(controller, "trust approve");
		expect(showError).toHaveBeenCalledWith(
			expect.stringContaining("Usage: /skills trust approve"),
		);
	});

	it("unknown subcommand surfaces a helpful error", () => {
		const { controller } = buildController([createSkill("review")]);
		const { showError } = run(controller, "trust bogus");
		expect(showError).toHaveBeenCalledWith(
			expect.stringContaining("Unknown subcommand"),
		);
	});
});
