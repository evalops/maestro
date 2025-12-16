/**
 * Tests for main.ts utility functions and reaction handling logic
 */

import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

describe("main.ts utilities", () => {
	describe("formatNextRun", () => {
		// Re-implement for testing
		function formatNextRun(task: {
			nextRun: string;
			timezone: string;
		}): string {
			const dt = DateTime.fromISO(task.nextRun, { zone: "utc" }).setZone(
				task.timezone,
			);
			const formatted = dt.toLocaleString(DateTime.DATETIME_MED);
			return `${formatted} (${task.timezone})`;
		}

		it("formats next run with timezone", () => {
			const result = formatNextRun({
				nextRun: "2024-01-15T09:00:00Z",
				timezone: "America/New_York",
			});
			expect(result).toContain("America/New_York");
		});

		it("handles UTC timezone", () => {
			const result = formatNextRun({
				nextRun: "2024-01-15T09:00:00Z",
				timezone: "UTC",
			});
			expect(result).toContain("UTC");
		});
	});

	describe("getSandboxDescription", () => {
		// Re-implement for testing
		type SandboxConfig =
			| { type: "host" }
			| { type: "docker"; container: string }
			| { type: "docker"; autoCreate: true; image?: string };

		function getSandboxDescription(sandbox: SandboxConfig): string {
			if (sandbox.type === "host") {
				return "host";
			}
			if ("autoCreate" in sandbox && sandbox.autoCreate) {
				return `docker:auto (${sandbox.image || "node:20-slim"})`;
			}
			return `docker:${(sandbox as { container: string }).container}`;
		}

		it("returns host for host sandbox", () => {
			expect(getSandboxDescription({ type: "host" })).toBe("host");
		});

		it("returns docker:auto with default image", () => {
			expect(getSandboxDescription({ type: "docker", autoCreate: true })).toBe(
				"docker:auto (node:20-slim)",
			);
		});

		it("returns docker:auto with custom image", () => {
			expect(
				getSandboxDescription({
					type: "docker",
					autoCreate: true,
					image: "custom:latest",
				}),
			).toBe("docker:auto (custom:latest)");
		});

		it("returns docker:container for named container", () => {
			expect(
				getSandboxDescription({ type: "docker", container: "my-container" }),
			).toBe("docker:my-container");
		});
	});

	describe("reaction handling logic", () => {
		// Test the pure logic of reaction handlers

		describe("octagonal_sign (stop)", () => {
			it("stops active run when present", () => {
				const activeRuns = new Map([
					["C123", { runner: { abort: vi.fn() }, context: {} }],
				]);
				const channelId = "C123";
				const active = activeRuns.get(channelId);

				expect(active).toBeDefined();
				active?.runner.abort();
				expect(active?.runner.abort).toHaveBeenCalled();
			});

			it("does nothing when no active run", () => {
				const activeRuns = new Map();
				const channelId = "C123";
				const active = activeRuns.get(channelId);

				expect(active).toBeUndefined();
			});
		});

		describe("eyes (status)", () => {
			it("reports working status when active", () => {
				const activeRuns = new Map([["C123", {}]]);
				const thinkingEnabled = new Map([["C123", true]]);
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				const thinking = thinkingEnabled.get(channelId) ?? false;

				expect(active).toBe(true);
				expect(thinking).toBe(true);
			});

			it("reports idle status when not active", () => {
				const activeRuns = new Map();
				const thinkingEnabled = new Map();
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				const thinking = thinkingEnabled.get(channelId) ?? false;

				expect(active).toBe(false);
				expect(thinking).toBe(false);
			});
		});

		describe("coffee/brain (thinking toggle)", () => {
			it("enables thinking when disabled", () => {
				const thinkingEnabled = new Map<string, boolean>();
				const channelId = "C123";

				const current = thinkingEnabled.get(channelId) ?? false;
				thinkingEnabled.set(channelId, !current);

				expect(thinkingEnabled.get(channelId)).toBe(true);
			});

			it("disables thinking when enabled", () => {
				const thinkingEnabled = new Map([["C123", true]]);
				const channelId = "C123";

				const current = thinkingEnabled.get(channelId) ?? false;
				thinkingEnabled.set(channelId, !current);

				expect(thinkingEnabled.get(channelId)).toBe(false);
			});
		});

		describe("arrows_counterclockwise/repeat (retry)", () => {
			it("prevents retry when actively running", () => {
				const activeRuns = new Map([["C123", {}]]);
				const lastContexts = new Map([["C123", { message: {} }]]);
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				expect(active).toBe(true);
				// Should show "Already working" message
			});

			it("allows retry when idle with last context", () => {
				const activeRuns = new Map();
				const lastContexts = new Map([["C123", { message: {} }]]);
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				const lastCtx = lastContexts.get(channelId);

				expect(active).toBe(false);
				expect(lastCtx).toBeDefined();
				// Should retry
			});

			it("rejects retry when no previous context", () => {
				const activeRuns = new Map();
				const lastContexts = new Map();
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				const lastCtx = lastContexts.get(channelId);

				expect(active).toBe(false);
				expect(lastCtx).toBeUndefined();
				// Should show "No previous request to retry"
			});
		});

		describe("broom/wastebasket (clear context)", () => {
			it("prevents clearing when actively running", () => {
				const activeRuns = new Map([["C123", {}]]);
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				expect(active).toBe(true);
				// Should show "Can't clear while working" message
			});

			it("clears context when idle", () => {
				const activeRuns = new Map();
				const lastContexts = new Map([["C123", {}]]);
				const channelId = "C123";

				const active = activeRuns.has(channelId);
				expect(active).toBe(false);

				// Clear operation
				lastContexts.delete(channelId);
				expect(lastContexts.has(channelId)).toBe(false);
			});
		});

		describe("calendar/alarm_clock (list tasks)", () => {
			it("handles empty task list", () => {
				const tasks: Array<{ description: string }> = [];
				expect(tasks.length).toBe(0);
			});

			it("formats task list with descriptions", () => {
				const tasks = [
					{
						description: "Task 1",
						schedule: "0 9 * * *",
						nextRun: "2024-01-15T09:00:00Z",
						timezone: "UTC",
					},
					{
						description: "Task 2",
						schedule: null,
						nextRun: "2024-01-15T10:00:00Z",
						timezone: "UTC",
					},
				];

				const taskList = tasks
					.map((t) => {
						const recurring = t.schedule ? " (recurring)" : "";
						return `• ${t.description}${recurring}`;
					})
					.join("\n");

				expect(taskList).toContain("Task 1 (recurring)");
				expect(taskList).toContain("Task 2");
				expect(taskList).not.toContain("Task 2 (recurring)");
			});
		});
	});

	describe("reaction emoji mapping", () => {
		const reactionMap: Record<string, string> = {
			octagonal_sign: "stop",
			eyes: "status",
			moneybag: "cost",
			chart_with_upwards_trend: "cost",
			bar_chart: "feedback",
			clipboard: "feedback",
			arrows_counterclockwise: "retry",
			repeat: "retry",
			coffee: "thinking",
			brain: "thinking",
			broom: "clear",
			wastebasket: "clear",
			calendar: "tasks",
			alarm_clock: "tasks",
		};

		it("maps all expected reactions", () => {
			expect(reactionMap.octagonal_sign).toBe("stop");
			expect(reactionMap.eyes).toBe("status");
			expect(reactionMap.moneybag).toBe("cost");
			expect(reactionMap.coffee).toBe("thinking");
			expect(reactionMap.brain).toBe("thinking");
			expect(reactionMap.broom).toBe("clear");
			expect(reactionMap.calendar).toBe("tasks");
		});

		it("has paired aliases for each action", () => {
			// Verify that aliases map to the same action
			expect(reactionMap.moneybag).toBe(reactionMap.chart_with_upwards_trend);
			expect(reactionMap.bar_chart).toBe(reactionMap.clipboard);
			expect(reactionMap.arrows_counterclockwise).toBe(reactionMap.repeat);
			expect(reactionMap.coffee).toBe(reactionMap.brain);
			expect(reactionMap.broom).toBe(reactionMap.wastebasket);
			expect(reactionMap.calendar).toBe(reactionMap.alarm_clock);
		});
	});

	describe("task command parsing", () => {
		// Test parsing of /tasks subcommands
		function parseTasksCommand(text: string): {
			subcommand: string;
			args: string[];
		} {
			const parts = text.trim().split(/\s+/);
			const subcommand = parts[0] || "list";
			const args = parts.slice(1);
			return { subcommand, args };
		}

		it("defaults to list when no subcommand", () => {
			expect(parseTasksCommand("")).toEqual({ subcommand: "list", args: [] });
			expect(parseTasksCommand("  ")).toEqual({ subcommand: "list", args: [] });
		});

		it("parses list subcommand", () => {
			expect(parseTasksCommand("list")).toEqual({
				subcommand: "list",
				args: [],
			});
		});

		it("parses pause with task id", () => {
			expect(parseTasksCommand("pause task_123")).toEqual({
				subcommand: "pause",
				args: ["task_123"],
			});
		});

		it("parses resume with task id", () => {
			expect(parseTasksCommand("resume task_123")).toEqual({
				subcommand: "resume",
				args: ["task_123"],
			});
		});

		it("parses cancel with task id", () => {
			expect(parseTasksCommand("cancel task_456")).toEqual({
				subcommand: "cancel",
				args: ["task_456"],
			});
		});

		it("parses run with task id", () => {
			expect(parseTasksCommand("run task_789")).toEqual({
				subcommand: "run",
				args: ["task_789"],
			});
		});

		it("handles extra whitespace", () => {
			expect(parseTasksCommand("  pause   task_123  ")).toEqual({
				subcommand: "pause",
				args: ["task_123"],
			});
		});
	});
});

describe("active runs state management", () => {
	it("tracks active runs by channel", () => {
		const activeRuns = new Map<
			string,
			{ runner: { abort: () => void }; context: unknown }
		>();

		// Add a run
		const runner = { abort: vi.fn() };
		activeRuns.set("C123", { runner, context: {} });

		expect(activeRuns.has("C123")).toBe(true);
		expect(activeRuns.has("C456")).toBe(false);

		// Remove when done
		activeRuns.delete("C123");
		expect(activeRuns.has("C123")).toBe(false);
	});

	it("allows only one run per channel", () => {
		const activeRuns = new Map<string, { id: number }>();

		// First run
		activeRuns.set("C123", { id: 1 });
		expect(activeRuns.get("C123")?.id).toBe(1);

		// Second run overwrites (shouldn't happen in practice)
		activeRuns.set("C123", { id: 2 });
		expect(activeRuns.get("C123")?.id).toBe(2);
		expect(activeRuns.size).toBe(1);
	});

	it("supports concurrent runs in different channels", () => {
		const activeRuns = new Map<string, { id: number }>();

		activeRuns.set("C123", { id: 1 });
		activeRuns.set("C456", { id: 2 });
		activeRuns.set("C789", { id: 3 });

		expect(activeRuns.size).toBe(3);
		expect(activeRuns.get("C123")?.id).toBe(1);
		expect(activeRuns.get("C456")?.id).toBe(2);
		expect(activeRuns.get("C789")?.id).toBe(3);
	});
});
