/**
 * Feedback Tracker - Track user reactions to bot messages
 *
 * Records thumbs up/down reactions as implicit feedback on bot responses.
 * This data can be used for analysis and improving the agent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirSync } from "./utils/fs.js";

export interface FeedbackRecord {
	timestamp: string;
	channelId: string;
	messageTs: string;
	userId: string;
	reaction: "positive" | "negative";
	emoji: string;
}

export interface FeedbackSummary {
	channelId: string;
	totalPositive: number;
	totalNegative: number;
	recentFeedback: FeedbackRecord[];
}

// Positive feedback reactions
const POSITIVE_REACTIONS = [
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

// Negative feedback reactions
const NEGATIVE_REACTIONS = [
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

export class FeedbackTracker {
	private workingDir: string;

	constructor(workingDir: string) {
		this.workingDir = workingDir;
	}

	/**
	 * Check if a reaction is feedback (positive or negative)
	 */
	isFeedbackReaction(
		reaction: string,
	): { type: "positive" | "negative" } | null {
		if (POSITIVE_REACTIONS.includes(reaction)) {
			return { type: "positive" };
		}
		if (NEGATIVE_REACTIONS.includes(reaction)) {
			return { type: "negative" };
		}
		return null;
	}

	/**
	 * Record feedback from a reaction
	 */
	record(
		channelId: string,
		messageTs: string,
		userId: string,
		reaction: string,
	): FeedbackRecord | null {
		const feedbackType = this.isFeedbackReaction(reaction);
		if (!feedbackType) {
			return null;
		}

		const record: FeedbackRecord = {
			timestamp: new Date().toISOString(),
			channelId,
			messageTs,
			userId,
			reaction: feedbackType.type,
			emoji: reaction,
		};

		this.appendFeedbackLog(channelId, record);
		return record;
	}

	/**
	 * Get feedback summary for a channel
	 */
	getSummary(channelId: string): FeedbackSummary {
		const records = this.loadFeedbackLog(channelId);

		let totalPositive = 0;
		let totalNegative = 0;

		for (const record of records) {
			if (record.reaction === "positive") {
				totalPositive++;
			} else {
				totalNegative++;
			}
		}

		// Get last 10 records
		const recentFeedback = records.slice(-10);

		return {
			channelId,
			totalPositive,
			totalNegative,
			recentFeedback,
		};
	}

	/**
	 * Format feedback summary for display
	 */
	formatSummary(summary: FeedbackSummary): string {
		const total = summary.totalPositive + summary.totalNegative;
		if (total === 0) {
			return "_No feedback recorded yet._";
		}

		const positivePercent =
			total > 0 ? Math.round((summary.totalPositive / total) * 100) : 0;

		const lines: string[] = [];
		lines.push("*Feedback Summary*");
		lines.push(`👍 Positive: ${summary.totalPositive} (${positivePercent}%)`);
		lines.push(`👎 Negative: ${summary.totalNegative}`);
		lines.push(`Total: ${total} reactions`);

		return lines.join("\n");
	}

	private getFeedbackLogPath(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		ensureDirSync(dir);
		return join(dir, "feedback.jsonl");
	}

	private loadFeedbackLog(channelId: string): FeedbackRecord[] {
		const path = this.getFeedbackLogPath(channelId);
		if (!existsSync(path)) {
			return [];
		}

		const records: FeedbackRecord[] = [];
		const content = readFileSync(path, "utf-8");

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// Skip malformed lines
			}
		}

		return records;
	}

	private appendFeedbackLog(channelId: string, record: FeedbackRecord): void {
		const path = this.getFeedbackLogPath(channelId);
		const line = `${JSON.stringify(record)}\n`;

		try {
			writeFileSync(path, line, { flag: "a" });
		} catch {
			// Directory may not exist yet, ignore
		}
	}
}
