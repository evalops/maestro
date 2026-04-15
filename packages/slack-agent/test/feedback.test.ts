import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackTracker } from "../src/feedback.js";

describe("FeedbackTracker", () => {
	let dir: string;
	let tracker: FeedbackTracker;

	beforeEach(async () => {
		dir = await mktemp();
		tracker = new FeedbackTracker(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function mktemp(): Promise<string> {
		const path = join(tmpdir(), `slack-agent-feedback-${Date.now()}`);
		await mkdir(path, { recursive: true });
		return path;
	}

	describe("isFeedbackReaction", () => {
		describe("positive reactions", () => {
			const positiveEmojis = [
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

			for (const emoji of positiveEmojis) {
				it(`recognizes ${emoji} as positive`, () => {
					expect(tracker.isFeedbackReaction(emoji)).toEqual({
						type: "positive",
					});
				});
			}
		});

		describe("negative reactions", () => {
			const negativeEmojis = [
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

			for (const emoji of negativeEmojis) {
				it(`recognizes ${emoji} as negative`, () => {
					expect(tracker.isFeedbackReaction(emoji)).toEqual({
						type: "negative",
					});
				});
			}
		});

		describe("non-feedback reactions", () => {
			it("returns null for non-feedback emojis", () => {
				expect(tracker.isFeedbackReaction("thinking_face")).toBeNull();
				expect(tracker.isFeedbackReaction("eyes")).toBeNull();
				expect(tracker.isFeedbackReaction("wave")).toBeNull();
				expect(tracker.isFeedbackReaction("smile")).toBeNull();
			});
		});
	});

	describe("record", () => {
		it("records positive feedback", () => {
			const result = tracker.record("C123", "1234.5678", "U456", "thumbsup");

			expect(result).not.toBeNull();
			expect(result?.reaction).toBe("positive");
			expect(result?.emoji).toBe("thumbsup");
			expect(result?.channelId).toBe("C123");
			expect(result?.messageTs).toBe("1234.5678");
			expect(result?.userId).toBe("U456");
			expect(result?.timestamp).toBeTruthy();
		});

		it("records negative feedback", () => {
			const result = tracker.record("C123", "1234.5678", "U456", "thumbsdown");

			expect(result).not.toBeNull();
			expect(result?.reaction).toBe("negative");
			expect(result?.emoji).toBe("thumbsdown");
		});

		it("returns null for non-feedback reactions", () => {
			const result = tracker.record("C123", "1234.5678", "U456", "wave");

			expect(result).toBeNull();
		});

		it("persists feedback to JSONL file", async () => {
			tracker.record("C123", "1234.5678", "U456", "thumbsup");

			const logPath = join(dir, "C123", "feedback.jsonl");
			const content = await readFile(logPath, "utf-8");
			const record = JSON.parse(content.trim());

			expect(record.reaction).toBe("positive");
			expect(record.emoji).toBe("thumbsup");
		});

		it("appends multiple records", async () => {
			tracker.record("C123", "1234.5678", "U456", "thumbsup");
			tracker.record("C123", "1234.5679", "U789", "thumbsdown");
			tracker.record("C123", "1234.5680", "U456", "star");

			const logPath = join(dir, "C123", "feedback.jsonl");
			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0]!).reaction).toBe("positive");
			expect(JSON.parse(lines[1]!).reaction).toBe("negative");
			expect(JSON.parse(lines[2]!).reaction).toBe("positive");
		});

		it("creates channel directory if needed", async () => {
			tracker.record("NEW_CHANNEL", "1234.5678", "U456", "thumbsup");

			const logPath = join(dir, "NEW_CHANNEL", "feedback.jsonl");
			const content = await readFile(logPath, "utf-8");
			expect(content).toBeTruthy();
		});
	});

	describe("getSummary", () => {
		it("returns empty summary for new channel", () => {
			const summary = tracker.getSummary("C123");

			expect(summary.channelId).toBe("C123");
			expect(summary.totalPositive).toBe(0);
			expect(summary.totalNegative).toBe(0);
			expect(summary.recentFeedback).toHaveLength(0);
		});

		it("counts positive and negative feedback", () => {
			tracker.record("C123", "1", "U1", "thumbsup");
			tracker.record("C123", "2", "U2", "thumbsup");
			tracker.record("C123", "3", "U3", "thumbsdown");
			tracker.record("C123", "4", "U4", "star");

			const summary = tracker.getSummary("C123");

			expect(summary.totalPositive).toBe(3);
			expect(summary.totalNegative).toBe(1);
		});

		it("includes recent feedback (last 10)", () => {
			for (let i = 0; i < 15; i++) {
				tracker.record("C123", `${i}`, `U${i}`, "thumbsup");
			}

			const summary = tracker.getSummary("C123");

			expect(summary.recentFeedback).toHaveLength(10);
			// Should be the last 10
			expect(summary.recentFeedback[0]!.messageTs).toBe("5");
			expect(summary.recentFeedback[9]!.messageTs).toBe("14");
		});

		it("tracks different channels independently", () => {
			tracker.record("C1", "1", "U1", "thumbsup");
			tracker.record("C1", "2", "U2", "thumbsup");
			tracker.record("C2", "1", "U1", "thumbsdown");

			const summary1 = tracker.getSummary("C1");
			const summary2 = tracker.getSummary("C2");

			expect(summary1.totalPositive).toBe(2);
			expect(summary1.totalNegative).toBe(0);
			expect(summary2.totalPositive).toBe(0);
			expect(summary2.totalNegative).toBe(1);
		});
	});

	describe("formatSummary", () => {
		it("formats empty summary", () => {
			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("No feedback recorded");
		});

		it("formats summary with feedback", () => {
			tracker.record("C123", "1", "U1", "thumbsup");
			tracker.record("C123", "2", "U2", "thumbsup");
			tracker.record("C123", "3", "U3", "thumbsdown");

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("Feedback Summary");
			expect(formatted).toContain("Positive: 2");
			expect(formatted).toContain("67%"); // 2/3 = 66.67% rounds to 67%
			expect(formatted).toContain("Negative: 1");
			expect(formatted).toContain("Total: 3");
		});

		it("shows 100% when all positive", () => {
			tracker.record("C123", "1", "U1", "thumbsup");
			tracker.record("C123", "2", "U2", "star");

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("100%");
		});

		it("shows 0% when all negative", () => {
			tracker.record("C123", "1", "U1", "thumbsdown");
			tracker.record("C123", "2", "U2", "-1");

			const summary = tracker.getSummary("C123");
			const formatted = tracker.formatSummary(summary);

			expect(formatted).toContain("0%");
		});
	});
});
