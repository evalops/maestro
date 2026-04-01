import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { LoadedComposer } from "../../src/composers/types.js";

const { getComposerByNameMock, loadComposersMock } = vi.hoisted(() => ({
	getComposerByNameMock: vi.fn(),
	loadComposersMock: vi.fn(),
}));

vi.mock("../../src/composers/loader.js", () => ({
	getComposerByName: getComposerByNameMock,
	loadComposers: loadComposersMock,
}));

vi.mock("../../src/models/registry.js", () => ({
	getRegisteredModels: vi.fn(() => []),
	resolveAlias: vi.fn(() => null),
	resolveModel: vi.fn(() => null),
}));

import { ComposerManager } from "../../src/composers/manager.js";

function createComposer(
	overrides: Partial<LoadedComposer> = {},
): LoadedComposer {
	return {
		name: "reviewer",
		description: "Reviews changes",
		systemPrompt: "Review the diff",
		tools: ["read", "diff"],
		denyTools: ["write"],
		triggers: {
			keywords: ["review"],
			files: ["src/**/*.ts"],
			directories: ["src/components"],
		},
		permissions: {
			default: "ask",
			tools: {
				read: "allow",
			},
			bash: {
				"npm test": "ask",
			},
		},
		source: "project",
		filePath: "/tmp/reviewer.yaml",
		...overrides,
	};
}

function createAgentStub(): Agent {
	return {
		state: {
			model: null,
			temperature: undefined,
			topP: undefined,
			thinkingLevel: undefined,
		},
		setSystemPrompt: vi.fn(),
		setTools: vi.fn(),
		setModel: vi.fn(),
		setTemperature: vi.fn(),
		setTopP: vi.fn(),
		setThinkingLevel: vi.fn(),
	} as unknown as Agent;
}

describe("ComposerManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const composer = createComposer();
		loadComposersMock.mockReturnValue([composer]);
		getComposerByNameMock.mockImplementation((name: string) =>
			name === composer.name ? composer : null,
		);
	});

	it("returns isolated state snapshots", () => {
		const manager = new ComposerManager();
		manager.initialize(createAgentStub(), "Base prompt", [], "/workspace");

		const snapshot = manager.getState();

		snapshot.available[0]!.name = "mutated";
		snapshot.available[0]!.tools!.push("bash");
		snapshot.available[0]!.triggers!.keywords!.push("mutated");
		snapshot.available[0]!.permissions!.tools!.read = "deny";
		snapshot.available.push(
			createComposer({ name: "extra", filePath: "/tmp/extra.yaml" }),
		);

		expect(manager.getState()).toEqual({
			active: null,
			available: [createComposer()],
		});
	});

	it("returns isolated active composer snapshots after activation", () => {
		const manager = new ComposerManager();
		manager.initialize(createAgentStub(), "Base prompt", [], "/workspace");
		expect(manager.activate("reviewer", "/workspace")).toBe(true);

		const snapshot = manager.getState();
		expect(snapshot.active?.name).toBe("reviewer");

		snapshot.active!.name = "mutated-active";
		snapshot.active!.tools!.push("bash");
		snapshot.active!.triggers!.files!.push("tmp/**");
		snapshot.active!.permissions!.bash!["rm -rf /"] = "allow";

		expect(manager.getState().active).toEqual(createComposer());
	});

	it("returns isolated composers from trigger lookups", () => {
		const manager = new ComposerManager();
		manager.initialize(createAgentStub(), "Base prompt", [], "/workspace");

		const triggered = manager.checkTriggers("Please review this diff");
		expect(triggered?.name).toBe("reviewer");

		triggered!.name = "mutated-trigger";
		triggered!.triggers!.keywords!.push("ship");
		triggered!.permissions!.tools!.read = "deny";

		expect(manager.checkTriggers("Please review this diff")).toEqual(
			createComposer(),
		);
		expect(manager.getState()).toEqual({
			active: null,
			available: [createComposer()],
		});
	});
});
