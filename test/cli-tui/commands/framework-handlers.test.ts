import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";

vi.mock("../../../src/config/framework.js", () => ({
	resolveFrameworkPreference: vi.fn(() => ({ id: "react", source: "user" })),
	listFrameworks: vi.fn(() => [
		{ id: "react", summary: "React with hooks" },
		{ id: "express", summary: "Express.js backend" },
	]),
	setDefaultFramework: vi.fn(),
	setWorkspaceFramework: vi.fn(),
	getFrameworkSummary: vi.fn((id: string) => {
		if (id === "react") return { summary: "React with hooks" };
		return null;
	}),
}));

import {
	type FrameworkCommandDeps,
	handleFrameworkCommand,
} from "../../../src/cli-tui/commands/framework-handlers.js";
import {
	listFrameworks,
	resolveFrameworkPreference,
	setDefaultFramework,
	setWorkspaceFramework,
} from "../../../src/config/framework.js";

function createMockContext(
	rawInput: string,
	argumentText = "",
): CommandExecutionContext {
	return {
		command: { name: "framework", description: "test" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

function createDeps(): FrameworkCommandDeps {
	return {
		showInfo: vi.fn(),
		showError: vi.fn(),
		showSuccess: vi.fn(),
	};
}

describe("framework-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleFrameworkCommand", () => {
		it("shows current framework when no argument given", () => {
			const ctx = createMockContext("/framework", "");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(resolveFrameworkPreference).toHaveBeenCalled();
			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("react"),
			);
		});

		it("lists all frameworks with 'list' argument", () => {
			const ctx = createMockContext("/framework list", "list");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(listFrameworks).toHaveBeenCalled();
			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Available frameworks"),
			);
			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("react"),
			);
		});

		it("sets default framework with a name", () => {
			const ctx = createMockContext("/framework react", "react");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setDefaultFramework).toHaveBeenCalledWith("react");
			expect(deps.showSuccess).toHaveBeenCalled();
		});

		it("clears framework with 'none'", () => {
			const ctx = createMockContext("/framework none", "none");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setDefaultFramework).toHaveBeenCalledWith(null);
			expect(deps.showSuccess).toHaveBeenCalledWith(
				expect.stringContaining("cleared"),
			);
		});

		it("clears framework with 'off'", () => {
			const ctx = createMockContext("/framework off", "off");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setDefaultFramework).toHaveBeenCalledWith(null);
		});

		it("uses workspace scope with -w flag", () => {
			const ctx = createMockContext("/framework -w react", "-w react");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setWorkspaceFramework).toHaveBeenCalledWith("react");
			expect(deps.showSuccess).toHaveBeenCalledWith(
				expect.stringContaining("workspace"),
			);
		});

		it("uses workspace scope with --workspace flag", () => {
			const ctx = createMockContext(
				"/framework --workspace react",
				"--workspace react",
			);
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setWorkspaceFramework).toHaveBeenCalledWith("react");
		});

		it("clears workspace scope with -w none", () => {
			const ctx = createMockContext("/framework -w none", "-w none");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(setWorkspaceFramework).toHaveBeenCalledWith(null);
			expect(deps.showSuccess).toHaveBeenCalledWith(
				expect.stringContaining("workspace"),
			);
		});

		it("shows error when setter throws", () => {
			vi.mocked(setDefaultFramework).mockImplementationOnce(() => {
				throw new Error("Unknown framework");
			});

			const ctx = createMockContext("/framework badid", "badid");
			const deps = createDeps();

			handleFrameworkCommand(ctx, deps);

			expect(deps.showError).toHaveBeenCalledWith("Unknown framework");
		});
	});
});
