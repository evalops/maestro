import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMessage } from "../../src/agent/types.js";
import { SkillsController } from "../../src/cli-tui/tui-renderer/skills-controller.js";
import { resetDefaultRuntimeEnvForTests } from "../../src/runtime/env.js";
import { composeSkill } from "../../src/skills/composer.js";
import type { LoadedSkill } from "../../src/skills/loader.js";
import { loadSkills } from "../../src/skills/loader.js";

vi.mock("../../src/skills/loader.js", () => ({
	loadSkills: vi.fn(),
	findSkill: vi.fn(
		(skills: LoadedSkill[], target: string) =>
			skills.find((skill) => skill.name === target) ?? null,
	),
	searchSkills: vi.fn(() => []),
	formatSkillForInjection: vi.fn((skill: LoadedSkill) =>
		skill.content.includes("Repository-specific review guidelines")
			? `Injected instructions for ${skill.name}\n${skill.content}\nsha=${skill.contentSha}`
			: `Injected instructions for ${skill.name}`,
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
				content: expect.stringContaining("Injected instructions for debug"),
				details: { name: "debug", action: "activate" },
			}),
		]);
	});

	it("activates and restores the composed skill payload", () => {
		const review = createSkill("review", {
			content: "# review\nBase review instructions.",
			contentSha: "c".repeat(64),
		});
		const guidelines = createSkill("review-guidelines", {
			content: "# review-guidelines\nRepository guidance.",
			contentSha: "d".repeat(64),
		});
		const skills = [review, guidelines];
		const composed = composeSkill(review, skills);
		expect(composed.contentSha).not.toBe(review.contentSha);
		vi.mocked(loadSkills).mockReturnValue({ skills, errors: [] });

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

		controller.handleSkillsCommand(createCommandContext("activate review"));
		expect(currentMessages.at(-1)?.content).toContain(
			"Repository-specific review guidelines",
		);
		expect(currentMessages.at(-1)?.content).toContain("Repository guidance.");
		expect(currentMessages.at(-1)?.content).toContain(
			`sha=${composed.contentSha}`,
		);

		currentMessages = [];
		const [restored] = controller.collectActiveSkillMessagesForCompaction([]);
		expect(restored?.content).toContain(
			"Repository-specific review guidelines",
		);
		expect(restored?.content).toContain("Repository guidance.");
		expect(restored?.content).toContain(`sha=${composed.contentSha}`);
	});
});

describe("SkillsController /skills trust (#2629)", () => {
	let resetTrustCacheForTests: () => void;
	let listApprovedSkillsForTests: () => Array<{ contentSha: string }>;
	let recordPromptApprovalForTests: (entry: {
		name: string;
		contentSha: string;
		sourceType: "project" | "user" | "system" | "service";
	}) => void;
	let previousMaestroHome: string | undefined;

	beforeEach(async () => {
		// Need a clean trust cache between tests; pin MAESTRO_HOME to
		// a temp dir so the cache file doesn't bleed into the dev's
		// real ~/.maestro.
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = mkdtempSync(
			join(tmpdir(), "maestro-skills-trust-test-"),
		);
		resetDefaultRuntimeEnvForTests();
		const tc = await import("../../src/skills/trust-cache.js");
		resetTrustCacheForTests = tc.resetTrustCacheForTests;
		listApprovedSkillsForTests = tc.listApprovedSkillsForTests;
		recordPromptApprovalForTests = tc.recordPromptApproval;
		resetTrustCacheForTests();
	});

	afterEach(() => {
		resetDefaultRuntimeEnvForTests();
		resetTrustCacheForTests();
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
	});

	function buildController(skills: LoadedSkill[]) {
		vi.mocked(loadSkills).mockReturnValue({ skills, errors: [] });
		const pushCommandOutput = vi.fn();
		const injectMessage = vi.fn();
		const controller = new SkillsController({
			deps: {
				injectMessage,
				getMessages: () => [],
				cwd: () => process.cwd(),
			},
			callbacks: {
				pushCommandOutput,
				showInfo: vi.fn(),
				showError: vi.fn(),
			},
		});
		return { controller, injectMessage, pushCommandOutput };
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

	it("revoke also drops stale approvals recorded for prior prompt SHAs", () => {
		const oldSha = "a".repeat(64);
		const currentSha = "b".repeat(64);
		const { controller } = buildController([
			createSkill("review", {
				sourceType: "project",
				contentSha: currentSha,
			}),
		]);

		recordPromptApprovalForTests({
			name: "review",
			contentSha: oldSha,
			sourceType: "project",
		});
		run(controller, "trust approve review");
		expect(listApprovedSkillsForTests().map((e) => e.contentSha)).toEqual(
			expect.arrayContaining([oldSha, currentSha]),
		);

		const { showInfo } = run(controller, "trust revoke review");

		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Revoked approval"),
		);
		expect(listApprovedSkillsForTests()).toEqual([]);
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

	it("list, approve, status, and revoke use the composed prompt SHA", () => {
		const review = createSkill("review", {
			sourceType: "project",
			content: "# review\nBase review instructions.",
			contentSha: "7".repeat(64),
		});
		const guidelines = createSkill("review-guidelines", {
			sourceType: "project",
			content: "# review-guidelines\nRepository guidance.",
			contentSha: "8".repeat(64),
		});
		const skills = [review, guidelines];
		const composed = composeSkill(review, skills);
		expect(composed.contentSha).not.toBe(review.contentSha);

		const { controller, pushCommandOutput } = buildController(skills);
		run(controller, "trust list");
		let out = pushCommandOutput.mock.calls.at(-1)?.[0] as string;
		expect(out).toContain(`sha=${composed.contentSha.slice(0, 12)}`);
		expect(out).not.toContain(`sha=${review.contentSha.slice(0, 12)}`);

		run(controller, "trust approve review");
		expect(
			listApprovedSkillsForTests().map((entry) => entry.contentSha),
		).toEqual([composed.contentSha]);

		run(controller, "trust status review");
		out = pushCommandOutput.mock.calls.at(-1)?.[0] as string;
		expect(out).toContain(`Prompt SHA: \`${composed.contentSha}\``);
		expect(out).toContain("approved");

		run(controller, "trust revoke review");
		expect(listApprovedSkillsForTests()).toEqual([]);
	});

	it("activate gates the composed prompt SHA through the trust cache", () => {
		const previousStrict = process.env.MAESTRO_SKILL_TRUST_STRICT;
		try {
			delete process.env.MAESTRO_SKILL_TRUST_STRICT;
			resetDefaultRuntimeEnvForTests();
			const review = createSkill("review", {
				sourceType: "system",
				content: "# review\nBase review instructions.",
				contentSha: "9".repeat(64),
			});
			const guidelines = createSkill("review-guidelines", {
				sourceType: "project",
				content: "# review-guidelines\nRepository guidance.",
				contentSha: "e".repeat(64),
			});
			const skills = [review, guidelines];
			const composed = composeSkill(review, skills);
			expect(composed.contentSha).not.toBe(review.contentSha);

			const { controller, injectMessage, pushCommandOutput } =
				buildController(skills);
			run(controller, "activate review");
			const injected = injectMessage.mock.calls[0]?.[0] as
				| AppMessage
				| undefined;
			expect(injected?.content).toContain("maestro-skill-trust: unapproved");
			expect(injected?.content).toContain(composed.contentSha);
			expect(injected?.content).toContain("Repository guidance.");

			process.env.MAESTRO_SKILL_TRUST_STRICT = "1";
			resetDefaultRuntimeEnvForTests();
			expect(controller.collectActiveSkillMessagesForCompaction([])).toEqual(
				[],
			);
			run(controller, "list");
			const listAfterStrictRefusal = String(
				pushCommandOutput.mock.calls.at(-1)?.[0] ?? "",
			);
			expect(listAfterStrictRefusal).not.toContain("review (active)");
			expect(listAfterStrictRefusal).not.toContain("Active: review");
			const reactivationAttempt = run(controller, "activate review");
			expect(reactivationAttempt.showError).toHaveBeenCalledWith(
				expect.stringContaining("refusing to activate"),
			);

			const strictController = buildController(skills);
			const { showError } = run(strictController.controller, "activate review");
			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("refusing to activate"),
			);
			expect(strictController.injectMessage).not.toHaveBeenCalled();

			recordPromptApprovalForTests({
				name: review.name,
				contentSha: composed.contentSha,
				sourceType: "system",
			});
			resetDefaultRuntimeEnvForTests();
			const approvedController = buildController(skills);
			run(approvedController.controller, "activate review");
			const approved = approvedController.injectMessage.mock.calls[0]?.[0] as
				| AppMessage
				| undefined;
			expect(approved?.content).not.toContain(
				"maestro-skill-trust: unapproved",
			);
			expect(approved?.content).toContain("Repository guidance.");
		} finally {
			if (previousStrict === undefined) {
				delete process.env.MAESTRO_SKILL_TRUST_STRICT;
			} else {
				process.env.MAESTRO_SKILL_TRUST_STRICT = previousStrict;
			}
			resetDefaultRuntimeEnvForTests();
		}
	});

	it("list requires approval for a composed built-in skill payload", () => {
		const review = createSkill("review", {
			content: "Base review instructions",
			contentSha: "7".repeat(64),
			sourceType: "system",
		});
		const guidelines = createSkill("review-guidelines", {
			content: "Repository-specific guidance",
			contentSha: "8".repeat(64),
			sourceType: "project",
		});
		const { controller, pushCommandOutput } = buildController([
			review,
			guidelines,
		]);
		const composed = composeSkill(review, [review, guidelines]);

		run(controller, "trust list");
		const out = pushCommandOutput.mock.calls[0]?.[0] as string;

		expect(out).toContain("review");
		expect(out).toContain("unapproved");
		expect(out).toContain(`sha=${composed.contentSha.slice(0, 12)}`);
		expect(out).not.toContain("built-in, no approval needed");
	});

	it("approve and status use the composed skill payload SHA", () => {
		const review = createSkill("review", {
			content: "Base review instructions",
			contentSha: "9".repeat(64),
			sourceType: "system",
		});
		const guidelines = createSkill("review-guidelines", {
			content: "Repository-specific guidance",
			contentSha: "a".repeat(64),
			sourceType: "project",
		});
		const { controller, pushCommandOutput } = buildController([
			review,
			guidelines,
		]);
		const composed = composeSkill(review, [review, guidelines]);

		const { showInfo } = run(controller, "trust approve review");

		expect(showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Approved skill"),
		);
		expect(
			listApprovedSkillsForTests().map((entry) => entry.contentSha),
		).toContain(composed.contentSha);
		expect(
			listApprovedSkillsForTests().map((entry) => entry.contentSha),
		).not.toContain(review.contentSha);

		run(controller, "trust status review");
		const out = pushCommandOutput.mock.calls.at(-1)?.[0] as string;
		expect(out).toContain(`Prompt SHA: \`${composed.contentSha}\``);
		expect(out).toContain("approved");
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
