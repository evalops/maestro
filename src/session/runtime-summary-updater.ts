import type { AgentEvent } from "../agent/types.js";

interface SessionSummarySink {
	getSessionFile(): string | null | undefined;
	saveSessionSummary(summary: string, sessionPath?: string): void;
	saveSessionResumeSummary(summary: string, sessionPath?: string): void;
}

export function createRuntimeSessionSummaryUpdater(
	sessionManager: SessionSummarySink,
): (event: AgentEvent) => void {
	let lastSavedSummary: string | null = null;

	return (event: AgentEvent) => {
		if (event.type !== "status") {
			return;
		}
		if (event.details.kind !== "tool_batch_summary") {
			return;
		}

		const summary = event.status.trim();
		if (!summary || summary === lastSavedSummary) {
			return;
		}

		const sessionPath = sessionManager.getSessionFile();
		if (!sessionPath) {
			return;
		}

		sessionManager.saveSessionSummary(summary, sessionPath);
		sessionManager.saveSessionResumeSummary(summary, sessionPath);
		lastSavedSummary = summary;
	};
}
