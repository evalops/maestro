import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type PlanModeConfig,
	type PlanModeState,
	appendToPlanFile,
	clearPlanModeState,
	enterPlanMode,
	exitPlanMode,
	generatePlanFilePath,
	getCurrentPlanFilePath,
	getPlanModeConfig,
	isPlanModeActive,
	listPlanFiles,
	loadPlanModeState,
	readPlanFile,
	savePlanModeState,
	writePlanFile,
} from "../../src/agent/plan-mode.js";

describe("Plan Mode Persistence", () => {
	let testDir: string;
	let testConfig: PlanModeConfig;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "composer-plan-mode-test-"));
		testConfig = {
			planDir: join(testDir, "plans"),
			stateFile: join(testDir, "plan-state.json"),
		};
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("getPlanModeConfig", () => {
		it("returns configuration with planDir and stateFile", () => {
			const config = getPlanModeConfig();

			expect(config.planDir).toBeDefined();
			expect(config.stateFile).toBeDefined();
			expect(config.stateFile).toContain("plan-state.json");
		});
	});

	describe("generatePlanFilePath", () => {
		it("generates a path in the plan directory", () => {
			const path = generatePlanFilePath(testConfig);

			expect(path).toContain(testConfig.planDir);
			expect(path.endsWith(".md")).toBe(true);
		});

		it("includes sanitized name in path", () => {
			const path = generatePlanFilePath(testConfig, "My Feature Plan");

			expect(path).toContain("my-feature-plan");
			expect(path.endsWith(".md")).toBe(true);
		});

		it("truncates long names", () => {
			const longName = "a".repeat(100);
			const path = generatePlanFilePath(testConfig, longName);

			// Name portion should be max 50 chars
			const filename = path.split("/").pop() || "";
			expect(filename.length).toBeLessThan(100);
		});
	});

	describe("savePlanModeState / loadPlanModeState", () => {
		it("saves and loads state", () => {
			const state: PlanModeState = {
				active: true,
				filePath: "/test/plan.md",
				sessionId: "test-session",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				name: "Test Plan",
			};

			savePlanModeState(state, testConfig);
			const loaded = loadPlanModeState(testConfig);

			expect(loaded).toEqual(state);
		});

		it("returns null when no state file exists", () => {
			const loaded = loadPlanModeState(testConfig);

			expect(loaded).toBeNull();
		});
	});

	describe("clearPlanModeState", () => {
		it("sets active to false", () => {
			const state: PlanModeState = {
				active: true,
				filePath: "/test/plan.md",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			savePlanModeState(state, testConfig);
			clearPlanModeState(testConfig);

			const loaded = loadPlanModeState(testConfig);
			expect(loaded?.active).toBe(false);
		});

		it("does not throw when no state exists", () => {
			expect(() => {
				clearPlanModeState(testConfig);
			}).not.toThrow();
		});
	});

	describe("enterPlanMode", () => {
		it("creates new plan mode state", () => {
			const state = enterPlanMode({
				sessionId: "test-session",
				name: "Test Feature",
				config: testConfig,
			});

			expect(state.active).toBe(true);
			expect(state.sessionId).toBe("test-session");
			expect(state.name).toBe("Test Feature");
			expect(state.filePath).toContain("test-feature");
		});

		it("creates plan file on disk", () => {
			const state = enterPlanMode({
				name: "Test Feature",
				config: testConfig,
			});

			expect(existsSync(state.filePath)).toBe(true);
		});

		it("resumes existing active plan", () => {
			const first = enterPlanMode({
				sessionId: "session-1",
				name: "First Plan",
				config: testConfig,
			});

			const second = enterPlanMode({
				sessionId: "session-2",
				config: testConfig,
			});

			// Should resume the first plan
			expect(second.filePath).toBe(first.filePath);
			expect(second.sessionId).toBe("session-2");
		});

		it("creates new plan when filePath explicitly provided", () => {
			const first = enterPlanMode({
				name: "First Plan",
				config: testConfig,
			});

			const newPath = join(testConfig.planDir, "new-plan.md");
			const second = enterPlanMode({
				filePath: newPath,
				config: testConfig,
			});

			expect(second.filePath).toBe(newPath);
			expect(second.filePath).not.toBe(first.filePath);
		});

		it("includes git state if provided", () => {
			const state = enterPlanMode({
				gitBranch: "feature/test",
				gitCommitSha: "abc123",
				config: testConfig,
			});

			expect(state.gitBranch).toBe("feature/test");
			expect(state.gitCommitSha).toBe("abc123");
		});
	});

	describe("exitPlanMode", () => {
		it("sets active to false and updates timestamp", () => {
			enterPlanMode({
				name: "Test",
				config: testConfig,
			});

			const exited = exitPlanMode(testConfig);

			expect(exited).not.toBeNull();
			expect(exited?.active).toBe(false);
		});

		it("returns null when not in plan mode", () => {
			const result = exitPlanMode(testConfig);

			expect(result).toBeNull();
		});
	});

	describe("isPlanModeActive", () => {
		it("returns false when not in plan mode", () => {
			expect(isPlanModeActive(testConfig)).toBe(false);
		});

		it("returns true when in plan mode", () => {
			enterPlanMode({ config: testConfig });

			expect(isPlanModeActive(testConfig)).toBe(true);
		});

		it("returns false after exiting plan mode", () => {
			enterPlanMode({ config: testConfig });
			exitPlanMode(testConfig);

			expect(isPlanModeActive(testConfig)).toBe(false);
		});
	});

	describe("getCurrentPlanFilePath", () => {
		it("returns null when not in plan mode", () => {
			expect(getCurrentPlanFilePath(testConfig)).toBeNull();
		});

		it("returns file path when in plan mode", () => {
			const state = enterPlanMode({ config: testConfig });

			expect(getCurrentPlanFilePath(testConfig)).toBe(state.filePath);
		});

		it("returns null after exiting plan mode", () => {
			enterPlanMode({ config: testConfig });
			exitPlanMode(testConfig);

			expect(getCurrentPlanFilePath(testConfig)).toBeNull();
		});
	});

	describe("readPlanFile / writePlanFile", () => {
		it("reads the current plan file", () => {
			enterPlanMode({
				name: "Test",
				config: testConfig,
			});

			const content = readPlanFile(testConfig);

			expect(content).toContain("# Plan: Test");
		});

		it("returns null when not in plan mode", () => {
			expect(readPlanFile(testConfig)).toBeNull();
		});

		it("writes content to the plan file", () => {
			enterPlanMode({ config: testConfig });

			const result = writePlanFile("# Custom Content\n\nTask 1", testConfig);

			expect(result).toBe(true);
			expect(readPlanFile(testConfig)).toBe("# Custom Content\n\nTask 1");
		});

		it("returns false when not in plan mode", () => {
			const result = writePlanFile("content", testConfig);

			expect(result).toBe(false);
		});
	});

	describe("appendToPlanFile", () => {
		it("appends content to existing plan", () => {
			enterPlanMode({
				name: "Test",
				config: testConfig,
			});

			const initial = readPlanFile(testConfig) || "";
			appendToPlanFile("\n\n- New task", testConfig);

			const updated = readPlanFile(testConfig);
			expect(updated).toBe(`${initial}\n\n- New task`);
		});

		it("returns false when not in plan mode", () => {
			const result = appendToPlanFile("content", testConfig);

			expect(result).toBe(false);
		});
	});

	describe("listPlanFiles", () => {
		it("returns empty array when no plans exist", () => {
			const files = listPlanFiles(testConfig);

			expect(files).toEqual([]);
		});

		it("lists plan files in directory", () => {
			// Create some plan files
			const planDir = testConfig.planDir;
			rmSync(planDir, { recursive: true, force: true });
			require("node:fs").mkdirSync(planDir, { recursive: true });
			writeFileSync(join(planDir, "plan1.md"), "# Plan 1");
			writeFileSync(join(planDir, "plan2.md"), "# Plan 2");
			writeFileSync(join(planDir, "not-a-plan.txt"), "text file");

			const files = listPlanFiles(testConfig);

			expect(files).toHaveLength(2);
			expect(files.some((f) => f.endsWith("plan1.md"))).toBe(true);
			expect(files.some((f) => f.endsWith("plan2.md"))).toBe(true);
		});
	});
});
