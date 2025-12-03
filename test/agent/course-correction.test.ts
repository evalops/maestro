import { beforeEach, describe, expect, it } from "vitest";
import {
	CourseCorrector,
	type CourseCorrectorConfig,
	createCourseCorrectionProvider,
	createCourseCorrector,
	formatCorrectionMessage,
} from "../../src/agent/course-correction.js";

describe("course-correction", () => {
	describe("CourseCorrector", () => {
		let corrector: CourseCorrector;

		beforeEach(() => {
			corrector = new CourseCorrector();
		});

		describe("initialization", () => {
			it("creates with default config", () => {
				expect(corrector.isEnabled()).toBe(true);
				expect(corrector.getState().totalCorrections).toBe(0);
			});

			it("respects custom config", () => {
				const custom = new CourseCorrector({ enabled: false });
				expect(custom.isEnabled()).toBe(false);
			});

			it("resets state correctly", () => {
				corrector.recordUserTurn("test");
				corrector.recordToolCall("Bash", { command: "ls" }, true);
				corrector.reset();
				expect(corrector.getState().currentTurn).toBe(0);
				expect(corrector.getState().recentToolCalls).toHaveLength(0);
			});
		});

		describe("repeated failure detection", () => {
			it("detects repeated tool failures", () => {
				corrector.recordUserTurn("test");

				// Simulate 3 consecutive failures
				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Bash", { command: "bad" }, false);

				const issues = corrector.detectIssues();
				expect(issues.length).toBeGreaterThan(0);
				expect(issues[0].type).toBe("repeated_failure");
				expect(issues[0].severity).toBeGreaterThanOrEqual(0.5);
			});

			it("resets failure count on success", () => {
				corrector.recordUserTurn("test");

				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Bash", { command: "good" }, true);
				corrector.recordToolCall("Bash", { command: "bad" }, false);

				const issues = corrector.detectIssues();
				const failureIssue = issues.find((i) => i.type === "repeated_failure");
				expect(failureIssue).toBeUndefined();
			});

			it("tracks failures per tool independently", () => {
				corrector.recordUserTurn("test");

				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Bash", { command: "bad" }, false);
				corrector.recordToolCall("Read", { path: "/missing" }, false);
				corrector.recordToolCall("Read", { path: "/missing" }, false);

				const issues = corrector.detectIssues();
				const failureIssue = issues.find((i) => i.type === "repeated_failure");
				// Neither tool has hit the threshold of 3
				expect(failureIssue).toBeUndefined();
			});
		});

		describe("loop detection", () => {
			it("detects repeated identical actions", () => {
				corrector.recordUserTurn("test");

				// Same action repeated 5 times
				for (let i = 0; i < 5; i++) {
					corrector.recordToolCall("Read", { path: "/same/file.ts" }, true);
				}

				const issues = corrector.detectIssues();
				const loopIssue = issues.find((i) => i.type === "loop_detected");
				expect(loopIssue).toBeDefined();
				expect(loopIssue?.severity).toBeGreaterThanOrEqual(0.5);
			});

			it("does not trigger on varied actions", () => {
				corrector.recordUserTurn("test");

				corrector.recordToolCall("Read", { path: "/file1.ts" }, true);
				corrector.recordToolCall("Read", { path: "/file2.ts" }, true);
				corrector.recordToolCall("Read", { path: "/file3.ts" }, true);
				corrector.recordToolCall("Edit", { path: "/file1.ts" }, true);
				corrector.recordToolCall("Bash", { command: "ls" }, true);

				const issues = corrector.detectIssues();
				const loopIssue = issues.find((i) => i.type === "loop_detected");
				expect(loopIssue).toBeUndefined();
			});
		});

		describe("excessive tool calls detection", () => {
			it("detects too many tool calls in one turn", () => {
				corrector.recordUserTurn("test");

				// Make 16 tool calls (default threshold is 15)
				for (let i = 0; i < 16; i++) {
					corrector.recordToolCall("Read", { path: `/file${i}.ts` }, true);
				}

				const issues = corrector.detectIssues();
				const excessiveIssue = issues.find(
					(i) => i.type === "excessive_tool_calls",
				);
				expect(excessiveIssue).toBeDefined();
			});

			it("resets tool call count on new turn", () => {
				corrector.recordUserTurn("test 1");

				for (let i = 0; i < 16; i++) {
					corrector.recordToolCall("Read", { path: `/file${i}.ts` }, true);
				}

				corrector.recordUserTurn("test 2");
				corrector.recordToolCall("Read", { path: "/new.ts" }, true);

				const issues = corrector.detectIssues();
				const excessiveIssue = issues.find(
					(i) => i.type === "excessive_tool_calls",
				);
				expect(excessiveIssue).toBeUndefined();
			});
		});

		describe("getCorrection", () => {
			it("returns null when disabled", () => {
				corrector.setConfig({ enabled: false });
				corrector.recordUserTurn("test");

				for (let i = 0; i < 5; i++) {
					corrector.recordToolCall("Bash", { command: "bad" }, false);
				}

				expect(corrector.getCorrection()).toBeNull();
			});

			it("returns correction for significant issues", () => {
				corrector.recordUserTurn("test");

				for (let i = 0; i < 3; i++) {
					corrector.recordToolCall("Bash", { command: "bad" }, false);
				}

				const correction = corrector.getCorrection();
				expect(correction).not.toBeNull();
				expect(correction).toContain("Bash");
			});

			it("increments correction count", () => {
				corrector.recordUserTurn("test");

				for (let i = 0; i < 3; i++) {
					corrector.recordToolCall("Bash", { command: "bad" }, false);
				}

				expect(corrector.getState().totalCorrections).toBe(0);
				corrector.getCorrection();
				expect(corrector.getState().totalCorrections).toBe(1);
			});

			it("respects max corrections per session", () => {
				const limitedCorrector = new CourseCorrector({
					maxCorrectionsPerSession: 2,
					minTurnsBetweenCorrections: 0,
				});

				// Trigger 3 corrections
				for (let turn = 0; turn < 3; turn++) {
					limitedCorrector.recordUserTurn(`turn ${turn}`);
					for (let i = 0; i < 3; i++) {
						limitedCorrector.recordToolCall("Bash", { command: "bad" }, false);
					}
					const correction = limitedCorrector.getCorrection();
					if (turn < 2) {
						expect(correction).not.toBeNull();
					} else {
						expect(correction).toBeNull();
					}
				}
			});

			it("respects minimum turns between corrections", () => {
				const spacedCorrector = new CourseCorrector({
					minTurnsBetweenCorrections: 3,
				});

				// First turn - should get correction
				spacedCorrector.recordUserTurn("turn 1");
				for (let i = 0; i < 3; i++) {
					spacedCorrector.recordToolCall("Bash", { command: "bad" }, false);
				}
				expect(spacedCorrector.getCorrection()).not.toBeNull();

				// Second turn - too soon
				spacedCorrector.recordUserTurn("turn 2");
				for (let i = 0; i < 3; i++) {
					spacedCorrector.recordToolCall("Read", { path: "/x" }, false);
				}
				expect(spacedCorrector.getCorrection()).toBeNull();

				// Skip to turn 5
				spacedCorrector.recordUserTurn("turn 3");
				spacedCorrector.recordUserTurn("turn 4");
				spacedCorrector.recordUserTurn("turn 5");
				for (let i = 0; i < 3; i++) {
					spacedCorrector.recordToolCall("Bash", { command: "bad" }, false);
				}
				expect(spacedCorrector.getCorrection()).not.toBeNull();
			});
		});

		describe("createCorrectionFromIssue", () => {
			it("creates correction and updates state", () => {
				corrector.recordUserTurn("test");

				const issue = {
					type: "scope_creep" as const,
					severity: 0.8,
					description: "Working on unrelated tasks",
					correction: "Please focus on the original request",
					evidence: ["found unrelated file edits"],
				};

				const correction = corrector.createCorrectionFromIssue(issue);
				expect(correction).toBe("Please focus on the original request");
				expect(corrector.getState().totalCorrections).toBe(1);
			});
		});
	});

	describe("createCourseCorrector", () => {
		it("creates corrector with custom config", () => {
			const corrector = createCourseCorrector({
				enabled: false,
				severityThreshold: 0.8,
			});

			expect(corrector.isEnabled()).toBe(false);
		});
	});

	describe("formatCorrectionMessage", () => {
		it("wraps correction in system-reminder tags", () => {
			const formatted = formatCorrectionMessage("Please reconsider");
			expect(formatted).toContain("<system-reminder>");
			expect(formatted).toContain("</system-reminder>");
			expect(formatted).toContain("[COURSE CORRECTION]");
			expect(formatted).toContain("Please reconsider");
		});
	});

	describe("createCourseCorrectionProvider", () => {
		it("creates a valid reminder provider", () => {
			const corrector = new CourseCorrector();
			const provider = createCourseCorrectionProvider(corrector);

			expect(provider.id).toBe("course-correction");
			expect(provider.minInterval).toBe(30000);
			expect(typeof provider.getReminders).toBe("function");
		});

		it("returns reminders when correction is needed", () => {
			const corrector = new CourseCorrector({
				minTurnsBetweenCorrections: 0,
			});

			corrector.recordUserTurn("test");
			for (let i = 0; i < 3; i++) {
				corrector.recordToolCall("Bash", { command: "bad" }, false);
			}

			const provider = createCourseCorrectionProvider(corrector);
			const mockContext = {
				state: {} as never,
				turnCount: 1,
				toolUsageTimes: new Map(),
				lastReminderTimes: new Map(),
				custom: {},
			};

			const reminders = provider.getReminders(mockContext);
			expect(reminders.length).toBeGreaterThan(0);
			expect(reminders[0].id).toBe("course-correction-active");
			expect(reminders[0].priority).toBe(10);
		});

		it("returns empty when no correction needed", () => {
			const corrector = new CourseCorrector();
			corrector.recordUserTurn("test");
			corrector.recordToolCall("Bash", { command: "ls" }, true);

			const provider = createCourseCorrectionProvider(corrector);
			const mockContext = {
				state: {} as never,
				turnCount: 1,
				toolUsageTimes: new Map(),
				lastReminderTimes: new Map(),
				custom: {},
			};

			const reminders = provider.getReminders(mockContext);
			expect(reminders).toHaveLength(0);
		});
	});

	describe("keyword extraction", () => {
		it("stores original request keywords", () => {
			const corrector = new CourseCorrector();
			corrector.recordUserTurn("Please fix the authentication bug in login");
			const state = corrector.getState();

			// Should extract meaningful keywords
			expect(state.requestKeywords.size).toBeGreaterThan(0);
			expect(state.requestKeywords.has("authentication")).toBe(true);
			expect(state.requestKeywords.has("login")).toBe(true);
		});

		it("filters out stop words", () => {
			const corrector = new CourseCorrector();
			corrector.recordUserTurn("Please help with this and that");
			const state = corrector.getState();

			expect(state.requestKeywords.has("please")).toBe(false);
			expect(state.requestKeywords.has("help")).toBe(false);
			expect(state.requestKeywords.has("this")).toBe(false);
			expect(state.requestKeywords.has("that")).toBe(false);
		});
	});

	describe("config updates", () => {
		it("allows runtime config changes", () => {
			const corrector = new CourseCorrector();
			expect(corrector.isEnabled()).toBe(true);

			corrector.setConfig({ enabled: false });
			expect(corrector.isEnabled()).toBe(false);

			corrector.setConfig({ enabled: true, severityThreshold: 0.9 });
			expect(corrector.isEnabled()).toBe(true);
		});
	});

	describe("issue severity", () => {
		it("increases severity with more failures", () => {
			const corrector = new CourseCorrector();
			corrector.recordUserTurn("test");

			// 3 failures
			for (let i = 0; i < 3; i++) {
				corrector.recordToolCall("Bash", { command: "bad" }, false);
			}
			const issues3 = corrector.detectIssues();
			const severity3 = issues3[0]?.severity ?? 0;

			// Reset and try with 5 failures
			corrector.reset();
			corrector.recordUserTurn("test");
			for (let i = 0; i < 5; i++) {
				corrector.recordToolCall("Bash", { command: "bad" }, false);
			}
			const issues5 = corrector.detectIssues();
			const severity5 = issues5[0]?.severity ?? 0;

			expect(severity5).toBeGreaterThan(severity3);
		});
	});
});
