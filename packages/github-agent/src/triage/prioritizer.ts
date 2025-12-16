/**
 * Issue Triage and Prioritization
 *
 * Decides which issues to work on based on:
 * - Labels (bug > feature > enhancement)
 * - Age (older issues get slight priority bump)
 * - Complexity estimate (simpler = higher priority for learning)
 * - Past success with similar issues
 */

import type { MemoryStore } from "../memory/store.js";
import type { GitHubIssue, Task } from "../types.js";

export interface TriageResult {
	shouldProcess: boolean;
	priority: number;
	reason: string;
	complexity: "low" | "medium" | "high";
}

// Label priority weights
const LABEL_WEIGHTS: Record<string, number> = {
	bug: 80,
	critical: 90,
	security: 95,
	"good-first-issue": 70,
	enhancement: 50,
	feature: 40,
	documentation: 30,
	refactor: 35,
	test: 45,
	"composer-task": 60, // Our target label
};

// Keywords that suggest complexity
const COMPLEXITY_KEYWORDS = {
	high: [
		"refactor",
		"architecture",
		"redesign",
		"migration",
		"breaking change",
		"security",
		"performance",
		"concurrency",
		"distributed",
	],
	low: [
		"typo",
		"documentation",
		"readme",
		"comment",
		"rename",
		"simple",
		"small",
		"minor",
		"trivial",
	],
};

export class IssuePrioritizer {
	constructor(private memory: MemoryStore) {}

	/**
	 * Analyze an issue and decide if/how to process it
	 */
	triage(issue: GitHubIssue): TriageResult {
		// Skip if we've already attempted this issue
		if (this.memory.hasAttemptedIssue(issue.number)) {
			return {
				shouldProcess: false,
				priority: 0,
				reason: "Already attempted",
				complexity: "medium",
			};
		}

		// Calculate base priority from labels
		let priority = this.calculateLabelPriority(issue.labels);

		// Estimate complexity
		const complexity = this.estimateComplexity(issue);

		// Adjust priority based on complexity
		// Lower complexity = higher priority (easier wins build confidence)
		if (complexity === "low") {
			priority += 15;
		} else if (complexity === "high") {
			priority -= 20;
		}

		// Age bonus - older issues get slight priority bump
		const ageInDays = this.getAgeInDays(issue.createdAt);
		priority += Math.min(ageInDays * 0.5, 10); // Max 10 points for age

		// Ensure priority is in valid range
		priority = Math.max(0, Math.min(100, Math.round(priority)));

		// Skip very complex issues until we have a good track record
		const stats = this.memory.getStats();
		if (complexity === "high" && stats.mergedPRs < 5) {
			return {
				shouldProcess: false,
				priority,
				reason: "Too complex - need more experience first",
				complexity,
			};
		}

		return {
			shouldProcess: true,
			priority,
			reason: this.generateReason(issue, complexity, priority),
			complexity,
		};
	}

	/**
	 * Create a Task from a triaged issue
	 */
	createTask(issue: GitHubIssue, triage: TriageResult): Task {
		return {
			id: `issue-${issue.number}-${Date.now().toString(36)}`,
			type: "issue",
			sourceIssue: issue.number,
			title: issue.title,
			description: this.formatDescription(issue),
			priority: triage.priority,
			createdAt: new Date().toISOString(),
			status: "pending",
			attempts: 0,
		};
	}

	private calculateLabelPriority(labels: string[]): number {
		let maxPriority = 30; // Base priority

		for (const label of labels) {
			const normalized = label.toLowerCase();
			for (const [key, weight] of Object.entries(LABEL_WEIGHTS)) {
				if (normalized.includes(key)) {
					maxPriority = Math.max(maxPriority, weight);
				}
			}
		}

		return maxPriority;
	}

	private estimateComplexity(issue: GitHubIssue): "low" | "medium" | "high" {
		const text = `${issue.title} ${issue.body || ""}`.toLowerCase();

		// Check for high complexity indicators
		for (const keyword of COMPLEXITY_KEYWORDS.high) {
			if (text.includes(keyword)) {
				return "high";
			}
		}

		// Check for low complexity indicators
		for (const keyword of COMPLEXITY_KEYWORDS.low) {
			if (text.includes(keyword)) {
				return "low";
			}
		}

		// Use body length as a heuristic
		const bodyLength = (issue.body || "").length;
		if (bodyLength < 200) {
			return "low";
		}
		if (bodyLength > 1000) {
			return "high";
		}

		return "medium";
	}

	private getAgeInDays(createdAt: string): number {
		const created = new Date(createdAt);
		const now = new Date();
		const diffMs = now.getTime() - created.getTime();
		return diffMs / (1000 * 60 * 60 * 24);
	}

	private generateReason(
		issue: GitHubIssue,
		complexity: string,
		priority: number,
	): string {
		const parts: string[] = [];

		if (priority >= 80) {
			parts.push("High priority");
		} else if (priority >= 50) {
			parts.push("Medium priority");
		} else {
			parts.push("Low priority");
		}

		parts.push(`${complexity} complexity`);

		// Use partial matching consistent with calculateLabelPriority
		const labelsLower = issue.labels.map((l) => l.toLowerCase());
		if (labelsLower.some((l) => l.includes("bug"))) {
			parts.push("bug fix");
		} else if (labelsLower.some((l) => l.includes("feature"))) {
			parts.push("new feature");
		}

		return parts.join(", ");
	}

	private formatDescription(issue: GitHubIssue): string {
		const lines: string[] = [
			`Issue #${issue.number}: ${issue.title}`,
			`URL: ${issue.url}`,
			`Labels: ${issue.labels.join(", ") || "none"}`,
			`Author: ${issue.author}`,
			"",
			"Description:",
			issue.body || "(no description)",
		];

		return lines.join("\n");
	}
}
