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
import { WebComposerManagerRegistry } from "../../src/server/web-composer-registry.js";

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

function createAgentStub(stateOverrides: Partial<Agent["state"]> = {}): Agent {
	return {
		state: {
			model: null,
			temperature: undefined,
			topP: undefined,
			thinkingLevel: undefined,
			isStreaming: false,
			...stateOverrides,
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

	it("reapplies active composer tool filters when base tools change", () => {
		const agent = createAgentStub();
		const manager = new ComposerManager();
		manager.initialize(
			agent,
			"Base prompt",
			[
				{
					name: "read",
					description: "Read files",
					parameters: {} as never,
					execute: vi.fn(),
				},
			],
			"/workspace",
		);

		expect(manager.activate("reviewer", "/workspace")).toBe(true);
		expect(agent.setTools).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ name: "read" })]),
		);

		const updatedBaseTools = [
			{
				name: "read",
				description: "Read files",
				parameters: {} as never,
				execute: vi.fn(),
			},
			{
				name: "diff",
				description: "Inspect changes",
				parameters: {} as never,
				execute: vi.fn(),
			},
			{
				name: "write",
				description: "Write files",
				parameters: {} as never,
				execute: vi.fn(),
			},
		];

		manager.updateBaseTools(updatedBaseTools);

		expect(agent.setTools).toHaveBeenLastCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ name: "read" }),
				expect.objectContaining({ name: "diff" }),
			]),
		);
		expect(agent.setTools).toHaveBeenLastCalledWith(
			expect.not.arrayContaining([expect.objectContaining({ name: "write" })]),
		);
	});

	it("keeps web composer managers scoped by session", () => {
		const registry = new WebComposerManagerRegistry();
		const agentA = createAgentStub();
		const agentB = createAgentStub();

		registry.initializeAgent(agentA, "Base A", [], "/workspace-a");
		registry.initializeAgent(agentB, "Base B", [], "/workspace-b");
		registry.bindAgentSession(agentA, "subject-1", "session-a");
		registry.bindAgentSession(agentB, "subject-1", "session-b");

		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);

		expect(agentA.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Review the diff"),
		);
		expect(agentB.setSystemPrompt).not.toHaveBeenCalled();
		expect(
			registry.get("subject-1", "session-b")?.getState().active,
		).toBeNull();
	});

	it("preserves the active web composer when a session gets a new agent", () => {
		const registry = new WebComposerManagerRegistry();
		const firstAgent = createAgentStub();
		const nextAgent = createAgentStub();

		registry.initializeAgent(firstAgent, "Base", [], "/workspace-a");
		registry.bindAgentSession(firstAgent, "subject-1", "session-a");
		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);

		registry.unbindAgentSession(firstAgent, "subject-1", "session-a");
		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");
		registry.bindAgentSession(nextAgent, "subject-1", "session-a");

		expect(nextAgent.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Review the diff"),
		);
		expect(registry.getLatestForSubject("subject-1")).toMatchObject({
			sessionId: "session-a",
		});
		expect(
			registry.get("subject-1", "session-a")?.getState().active?.name,
		).toBe("reviewer");
	});

	it("reclaims idle same-session binds after a stale agent is left behind", () => {
		const registry = new WebComposerManagerRegistry();
		const firstAgent = createAgentStub();
		const nextAgent = createAgentStub();

		registry.initializeAgent(firstAgent, "Base", [], "/workspace-a");
		expect(
			registry.bindAgentSession(firstAgent, "subject-1", "session-a"),
		).toBe(true);
		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);

		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");
		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			true,
		);
		expect(nextAgent.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Review the diff"),
		);
		registry.unbindAgentSession(firstAgent, "subject-1", "session-a");
		expect(
			registry.get("subject-1", "session-a")?.getState().active?.name,
		).toBe("reviewer");
	});

	it("rejects concurrent same-session binds until the active agent unbinds", () => {
		const registry = new WebComposerManagerRegistry();
		const firstAgent = createAgentStub({ isStreaming: true });
		const nextAgent = createAgentStub();

		registry.initializeAgent(firstAgent, "Base", [], "/workspace-a");
		expect(
			registry.bindAgentSession(firstAgent, "subject-1", "session-a"),
		).toBe(true);
		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);

		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");
		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			false,
		);
		expect(nextAgent.setSystemPrompt).not.toHaveBeenCalled();

		registry.unbindAgentSession(firstAgent, "subject-1", "session-a");
		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			true,
		);
		expect(nextAgent.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Review the diff"),
		);
		expect(
			registry.get("subject-1", "session-a")?.getState().active?.name,
		).toBe("reviewer");
	});

	it("detaches ended chat agents while preserving session composer state", () => {
		const registry = new WebComposerManagerRegistry();
		const firstAgent = createAgentStub();
		const nextAgent = createAgentStub();
		const planner = createComposer({
			name: "planner",
			systemPrompt: "Plan the next steps",
		});
		getComposerByNameMock.mockImplementation((name: string) => {
			if (name === "reviewer") {
				return createComposer();
			}
			return name === "planner" ? planner : null;
		});

		registry.initializeAgent(firstAgent, "Base", [], "/workspace-a");
		expect(
			registry.bindAgentSession(firstAgent, "subject-1", "session-a"),
		).toBe(true);
		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);
		expect(firstAgent.setSystemPrompt).toHaveBeenCalledTimes(1);

		registry.unbindAgentSession(firstAgent, "subject-1", "session-a");
		expect(registry.get("subject-1", "session-a")?.activate("planner")).toBe(
			true,
		);
		expect(firstAgent.setSystemPrompt).toHaveBeenCalledTimes(1);

		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");
		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			true,
		);
		expect(nextAgent.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Plan the next steps"),
		);
		expect(
			registry.get("subject-1", "session-a")?.getState().active?.name,
		).toBe("planner");
	});

	it("rejects rebinding when the active session composer cannot be restored", () => {
		const registry = new WebComposerManagerRegistry();
		const nextAgent = createAgentStub();
		const sessionManager = registry.getOrCreate("subject-1", "session-a");
		expect(sessionManager.activate("reviewer")).toBe(true);

		getComposerByNameMock.mockReturnValue(null);
		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");

		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			false,
		);
		expect(nextAgent.setSystemPrompt).not.toHaveBeenCalled();
		expect(registry.get("subject-1", "session-a")).toBe(sessionManager);
		expect(
			registry.get("subject-1", "session-a")?.getState().active?.name,
		).toBe("reviewer");
	});

	it("keeps the stale agent attached when same-session restore fails", () => {
		const registry = new WebComposerManagerRegistry();
		const firstAgent = createAgentStub();
		const nextAgent = createAgentStub();
		const planner = createComposer({
			name: "planner",
			systemPrompt: "Plan the next steps",
		});

		registry.initializeAgent(firstAgent, "Base", [], "/workspace-a");
		expect(
			registry.bindAgentSession(firstAgent, "subject-1", "session-a"),
		).toBe(true);
		expect(registry.get("subject-1", "session-a")?.activate("reviewer")).toBe(
			true,
		);
		expect(firstAgent.setSystemPrompt).toHaveBeenCalledTimes(1);

		getComposerByNameMock.mockImplementation((name: string) =>
			name === "planner" ? planner : null,
		);
		registry.initializeAgent(nextAgent, "Base", [], "/workspace-a");

		expect(registry.bindAgentSession(nextAgent, "subject-1", "session-a")).toBe(
			false,
		);
		expect(nextAgent.setSystemPrompt).not.toHaveBeenCalled();
		expect(registry.get("subject-1", "session-a")?.activate("planner")).toBe(
			true,
		);
		expect(firstAgent.setSystemPrompt).toHaveBeenCalledWith(
			expect.stringContaining("Plan the next steps"),
		);
	});
});
