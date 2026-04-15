/**
 * Tests for the FeedbackTracker
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackTracker } from "../../packages/slack-agent/src/feedback.js";

describe("FeedbackTracker", () => {
	let testDir: string;
	let tracker: FeedbackTracker;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`feedback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		tracker = new FeedbackTracker(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("isFeedbackReaction", () => {
		describe("positive reactions", () => {
			const positiveReactions = [
				"thumbsup",
				"+1",
				"white_check_mark",
				"heavy_check_mark",
				"star",
				"star2",
				"raised_hands",
				"clap",
				"100",
				"heart",
				"fire",
				"rocket",
				"tada",
			];

			for (const reaction of positiveReactions) {
				it(`identifies ${reaction} as positive`, () => {
					const result = tracker.isFeedbackReaction(reaction);
					expect(result).toEqual({ type: "positive" });
				});
			}
		});

		describe("negative reactions", () => {
			const negativeReactions = [
				"thumbsdown",
				"-1",
				"x",
				"no_entry",
				"no_entry_sign",
				"disappointed",
				"confused",
				"face_with_rolling_eyes",
				"unamused",
			];

			for (const reaction of negativeReactions) {
				it(`identifies ${reaction} as negative`, () => {
					const result = tracker.isFeedbackReaction(reaction);
					expect(result).toEqual({ type: "negative" });
				});
			}
		});

		describe("non-feedback reactions", () => {
			const nonFeedbackReactions = [
				"eyes",
				"thinking_face",
				"wave",
				"coffee",
				"octagonal_sign",
				"broom",
				"calendar",
			];

			for (const reaction of nonFeedbackReactions) {
				it(`returns null for ${reaction}`, () => {
					const result = tracker.isFeedbackReaction(reaction);
					expect(result).toBeNull();
				});
			}
		});
	});

	describe("record", () => {
		it("records positive feedback", () => {
			const record = tracker.record(
				"C123456",
				"1705312800.000000",
				"U789",
				"thumbsup",
			);

			expect(record).not.toBeNull();
			expect(record?.reaction).toBe("positive");
			expect(record?.emoji).toBe("thumbsup");
			expect(record?.channelId).toBe("C123456");
			expect(record?.messageTs).toBe("1705312800.000000");
			expect(record?.userId).toBe("U789");
			expect(record?.timestamp).toBeDefined();
		});

		it("records negative feedback", () => {
			const record = tracker.record(
				"C123456",
				"1705312800.000000",
				"U789",
				"thumbsdown",
			);

			expect(record).not.toBeNull();
			expect(record?.reaction).toBe("negative");
			expect(record?.emoji).toBe("thumbsdown");
		});

		it("returns null for non-feedback reactions", () => {
			const record = tracker.record(
				"C123456",
				"1705312800.000000",
				"U789",
				"eyes",
			);

			expect(record).toBeNull();
		});

		it("persists feedback to JSONL file", () => {
			tracker.record("C123456", "1705312800.000000", "U789", "thumbsup");

			const logPath = join(testDir, "C123456", "feedback.jsonl");
			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);

			const record = JSON.parse(lines[0]!);
			expect(record.reaction).toBe("positive");
		});

		it("appends multiple feedback records", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C123456", "1705312860.000000", "U2", "thumbsdown");
			tracker.record("C123456", "1705312920.000000", "U3", "heart");

			const logPath = join(testDir, "C123456", "feedback.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(3);
		});

		it("creates channel directory if needed", () => {
			const channelDir = join(testDir, "C999999");
			expect(existsSync(channelDir)).toBe(false);

			tracker.record("C999999", "1705312800.000000", "U789", "thumbsup");

			expect(existsSync(channelDir)).toBe(true);
		});
	});

	describe("getSummary", () => {
		it("returns empty summary for new channel", () => {
			const summary = tracker.getSummary("C123456");

			expect(summary.channelId).toBe("C123456");
			expect(summary.totalPositive).toBe(0);
			expect(summary.totalNegative).toBe(0);
			expect(summary.recentFeedback).toHaveLength(0);
		});

		it("counts positive and negative feedback", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C123456", "1705312860.000000", "U2", "thumbsup");
			tracker.record("C123456", "1705312920.000000", "U3", "thumbsdown");

			const summary = tracker.getSummary("C123456");

			expect(summary.totalPositive).toBe(2);
			expect(summary.totalNegative).toBe(1);
		});

		it("returns recent feedback records", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C123456", "1705312860.000000", "U2", "heart");
			tracker.record("C123456", "1705312920.000000", "U3", "thumbsdown");

			const summary = tracker.getSummary("C123456");

			expect(summary.recentFeedback).toHaveLength(3);
			expect(summary.recentFeedback[0]!.emoji).toBe("thumbsup");
			expect(summary.recentFeedback[2]!.emoji).toBe("thumbsdown");
		});

		it("limits recent feedback to 10 records", () => {
			// Record 15 feedbacks
			for (let i = 0; i < 15; i++) {
				tracker.record(
					"C123456",
					`170531280${i}.000000`,
					`U${i}`,
					i % 2 === 0 ? "thumbsup" : "thumbsdown",
				);
			}

			const summary = tracker.getSummary("C123456");

			expect(summary.recentFeedback).toHaveLength(10);
			expect(summary.totalPositive + summary.totalNegative).toBe(15);
		});

		it("isolates feedback by channel", () => {
			tracker.record("C111111", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C222222", "1705312800.000000", "U2", "thumbsdown");
			tracker.record("C222222", "1705312860.000000", "U3", "thumbsdown");

			const summary1 = tracker.getSummary("C111111");
			const summary2 = tracker.getSummary("C222222");

			expect(summary1.totalPositive).toBe(1);
			expect(summary1.totalNegative).toBe(0);
			expect(summary2.totalPositive).toBe(0);
			expect(summary2.totalNegative).toBe(2);
		});
	});

	describe("formatSummary", () => {
		it("shows message when no feedback", () => {
			const summary = tracker.getSummary("C123456");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("No feedback recorded");
		});

		it("shows counts and percentages", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C123456", "1705312860.000000", "U2", "thumbsup");
			tracker.record("C123456", "1705312920.000000", "U3", "thumbsup");
			tracker.record("C123456", "1705312980.000000", "U4", "thumbsdown");

			const summary = tracker.getSummary("C123456");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("Feedback Summary");
			expect(formatted).toContain("Positive: 3");
			expect(formatted).toContain("75%");
			expect(formatted).toContain("Negative: 1");
			expect(formatted).toContain("Total: 4");
		});

		it("handles 100% positive", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsup");
			tracker.record("C123456", "1705312860.000000", "U2", "heart");

			const summary = tracker.getSummary("C123456");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("100%");
			expect(formatted).toContain("Negative: 0");
		});

		it("handles 0% positive", () => {
			tracker.record("C123456", "1705312800.000000", "U1", "thumbsdown");
			tracker.record("C123456", "1705312860.000000", "U2", "-1");

			const summary = tracker.getSummary("C123456");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("0%");
		});
	});
});
