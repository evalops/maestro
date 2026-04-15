import {
	extractMemoryTags,
	formatMemoryRelativeTime,
	truncateMemoryText,
} from "@evalops/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	MemoryEntry,
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemoryStats,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicSummary,
	MemoryTopicsResponse,
	TeamMemoryMutationResponse,
	TeamMemoryStatus,
	TeamMemoryStatusResponse,
} from "../../lib/api-client";

type MemoryView =
	| { kind: "recent" }
	| { kind: "topic"; topic: string }
	| { kind: "search"; query: string };

export interface MemorySectionProps {
	sessionId?: string | null;
	onListMemoryTopics: (sessionId?: string) => Promise<MemoryTopicsResponse>;
	onListMemoryTopic: (
		topic: string,
		sessionId?: string,
	) => Promise<MemoryTopicResponse>;
	onSearchMemory: (
		query: string,
		limit?: number,
		sessionId?: string,
	) => Promise<MemorySearchResponse>;
	onGetRecentMemories: (
		limit?: number,
		sessionId?: string,
	) => Promise<MemoryRecentResponse>;
	onGetMemoryStats: (sessionId?: string) => Promise<MemoryStatsResponse>;
	onGetTeamMemoryStatus: () => Promise<TeamMemoryStatusResponse>;
	onInitTeamMemory: () => Promise<TeamMemoryMutationResponse>;
	onSaveMemory: (
		topic: string,
		content: string,
		tags?: string[],
		sessionId?: string,
	) => Promise<MemoryMutationResponse>;
	onDeleteMemory: (
		id?: string,
		topic?: string,
	) => Promise<MemoryMutationResponse>;
	onClearMemory: (force?: boolean) => Promise<MemoryMutationResponse>;
}

const EMPTY_STATS: MemoryStats = {
	totalEntries: 0,
	topics: 0,
	oldestEntry: null,
	newestEntry: null,
};

function getViewLabel(view: MemoryView): string {
	switch (view.kind) {
		case "topic":
			return `Topic: ${view.topic}`;
		case "search":
			return `Search results for "${view.query}"`;
		default:
			return "Recent memories";
	}
}

export function MemorySection({
	sessionId,
	onListMemoryTopics,
	onListMemoryTopic,
	onSearchMemory,
	onGetRecentMemories,
	onGetMemoryStats,
	onGetTeamMemoryStatus,
	onInitTeamMemory,
	onSaveMemory,
	onDeleteMemory,
	onClearMemory,
}: MemorySectionProps) {
	const [stats, setStats] = useState<MemoryStats>(EMPTY_STATS);
	const [topics, setTopics] = useState<MemoryTopicSummary[]>([]);
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [activeView, setActiveView] = useState<MemoryView>({ kind: "recent" });
	const [searchQuery, setSearchQuery] = useState("");
	const [saveTopic, setSaveTopic] = useState("");
	const [saveContent, setSaveContent] = useState("");
	const [clearConfirmed, setClearConfirmed] = useState(false);
	const [sessionOnly, setSessionOnly] = useState(Boolean(sessionId));
	const [teamMemoryAvailable, setTeamMemoryAvailable] = useState(false);
	const [teamMemoryStatus, setTeamMemoryStatus] =
		useState<TeamMemoryStatus | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const activeSessionId = sessionOnly ? (sessionId ?? undefined) : undefined;
	const updateSaveTopic = useCallback((value: string) => {
		setSaveTopic(value);
	}, []);
	const updateSaveContent = useCallback((value: string) => {
		setSaveContent(value);
	}, []);
	const updateSearchQuery = useCallback((value: string) => {
		setSearchQuery(value);
	}, []);

	const refreshSummary = useCallback(async () => {
		const [topicsResponse, statsResponse] = await Promise.all([
			onListMemoryTopics(activeSessionId),
			onGetMemoryStats(activeSessionId),
		]);
		setTopics(topicsResponse.topics ?? []);
		setStats(statsResponse.stats ?? EMPTY_STATS);
	}, [activeSessionId, onGetMemoryStats, onListMemoryTopics]);

	const refreshTeamMemoryStatus = useCallback(async () => {
		const response = await onGetTeamMemoryStatus();
		setTeamMemoryAvailable(response.available);
		setTeamMemoryStatus(response.status);
	}, [onGetTeamMemoryStatus]);

	const loadView = useCallback(
		async (view: MemoryView) => {
			if (view.kind === "topic") {
				const response = await onListMemoryTopic(view.topic, activeSessionId);
				setEntries(response.memories ?? []);
				return;
			}
			if (view.kind === "search") {
				const response = await onSearchMemory(view.query, 12, activeSessionId);
				setEntries((response.results ?? []).map((result) => result.entry));
				return;
			}
			const response = await onGetRecentMemories(12, activeSessionId);
			setEntries(response.memories ?? []);
		},
		[activeSessionId, onGetRecentMemories, onListMemoryTopic, onSearchMemory],
	);

	const runAction = useCallback(async (action: () => Promise<void>) => {
		setLoading(true);
		setError(null);
		setStatusMessage(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Memory action failed");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!sessionId) {
			setSessionOnly(false);
		}
	}, [sessionId]);

	useEffect(() => {
		let active = true;

		const load = async () => {
			setLoading(true);
			setError(null);
			try {
				const [topicsResponse, statsResponse, recentResponse, teamResponse] =
					await Promise.all([
						onListMemoryTopics(activeSessionId),
						onGetMemoryStats(activeSessionId),
						onGetRecentMemories(12, activeSessionId),
						onGetTeamMemoryStatus(),
					]);
				if (!active) return;
				setTopics(topicsResponse.topics ?? []);
				setStats(statsResponse.stats ?? EMPTY_STATS);
				setEntries(recentResponse.memories ?? []);
				setTeamMemoryAvailable(teamResponse.available);
				setTeamMemoryStatus(teamResponse.status);
			} catch (err) {
				if (!active) return;
				setError(err instanceof Error ? err.message : "Failed to load memory");
			} finally {
				if (active) {
					setLoading(false);
				}
			}
		};

		load();

		return () => {
			active = false;
		};
	}, [
		activeSessionId,
		onGetMemoryStats,
		onGetRecentMemories,
		onGetTeamMemoryStatus,
		onListMemoryTopics,
	]);

	const handleShowRecent = useCallback(async () => {
		const nextView: MemoryView = { kind: "recent" };
		await runAction(async () => {
			setActiveView(nextView);
			await loadView(nextView);
		});
	}, [loadView, runAction]);

	const handleTopicSelect = useCallback(
		async (topic: string) => {
			const nextView: MemoryView = { kind: "topic", topic };
			await runAction(async () => {
				setActiveView(nextView);
				await loadView(nextView);
			});
		},
		[loadView, runAction],
	);

	const handleSearch = useCallback(async () => {
		const query = searchQuery.trim();
		if (!query) {
			setError("Enter a memory search query.");
			return;
		}
		const nextView: MemoryView = { kind: "search", query };
		await runAction(async () => {
			setActiveView(nextView);
			await loadView(nextView);
		});
	}, [loadView, runAction, searchQuery]);

	const handleSave = useCallback(async () => {
		const topic = saveTopic.trim();
		const content = saveContent.trim();
		if (!topic || !content) {
			setError("Topic and content are required.");
			return;
		}

		await runAction(async () => {
			const tags = extractMemoryTags(content);
			const result = await onSaveMemory(
				topic,
				content,
				tags.length ? tags : undefined,
				activeSessionId,
			);
			const savedTopic = result.entry?.topic ?? topic;
			setStatusMessage(
				result.message || `Memory saved to topic "${savedTopic}"`,
			);
			setSaveTopic("");
			setSaveContent("");
			await refreshSummary();
			const nextView: MemoryView = { kind: "topic", topic: savedTopic };
			setActiveView(nextView);
			await loadView(nextView);
		});
	}, [
		loadView,
		activeSessionId,
		onSaveMemory,
		refreshSummary,
		runAction,
		saveContent,
		saveTopic,
	]);

	const handleDelete = useCallback(
		async (entry: MemoryEntry) => {
			await runAction(async () => {
				const result = await onDeleteMemory(entry.id);
				setStatusMessage(result.message || `Memory ${entry.id} deleted`);
				await refreshSummary();
				await loadView(activeView);
			});
		},
		[activeView, loadView, onDeleteMemory, refreshSummary, runAction],
	);

	const handleClear = useCallback(async () => {
		if (!clearConfirmed) {
			setError("Enable confirmation before clearing all memories.");
			return;
		}

		await runAction(async () => {
			const result = await onClearMemory(true);
			setStatusMessage(result.message || "Cleared all memories");
			setClearConfirmed(false);
			setActiveView({ kind: "recent" });
			setEntries([]);
			await refreshSummary();
		});
	}, [clearConfirmed, onClearMemory, refreshSummary, runAction]);

	const handleInitTeamMemory = useCallback(async () => {
		await runAction(async () => {
			const result = await onInitTeamMemory();
			setStatusMessage(result.message || "Team memory initialized.");
			await refreshTeamMemoryStatus();
		});
	}, [onInitTeamMemory, refreshTeamMemoryStatus, runAction]);

	const viewLabel = useMemo(() => getViewLabel(activeView), [activeView]);

	return (
		<section className="border border-line-subtle rounded-xl overflow-hidden">
			<div className="px-4 py-2 text-xs font-semibold text-text-tertiary border-b border-line-subtle uppercase tracking-wide">
				Memory
			</div>
			<div className="p-4 space-y-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="text-text-primary font-medium">
							{sessionOnly ? "Current-session memory" : "Cross-session memory"}
						</div>
						<div className="text-xs text-text-muted">
							Save, search, and prune durable notes without leaving desktop.
						</div>
					</div>
					<div className="text-xs text-text-muted text-right">
						<div>Entries: {stats.totalEntries}</div>
						<div>Topics: {stats.topics}</div>
						<div>Newest: {formatMemoryRelativeTime(stats.newestEntry)}</div>
					</div>
				</div>

				{sessionId && (
					<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
						<input
							aria-label="Show current session memories only"
							type="checkbox"
							checked={sessionOnly}
							onChange={(event) => setSessionOnly(event.target.checked)}
							className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
						/>
						<span>Show current session only</span>
					</label>
				)}

				{error && (
					<div className="border border-error/40 bg-error/10 text-error px-3 py-2 rounded-lg text-xs">
						{error}
					</div>
				)}

				{statusMessage && !error && (
					<div className="border border-accent/30 bg-accent/10 text-text-primary px-3 py-2 rounded-lg text-xs">
						{statusMessage}
					</div>
				)}

				<div className="border border-line-subtle rounded-lg px-3 py-3 bg-bg-tertiary/30 space-y-2">
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
								Team memory
							</div>
							<div className="text-[11px] text-text-muted">
								Repo-scoped durable notes loaded into prompt context.
							</div>
						</div>
						{teamMemoryAvailable &&
							teamMemoryStatus &&
							!teamMemoryStatus.exists && (
								<button
									type="button"
									aria-label="Initialize team memory"
									className="px-2 py-1 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
									onClick={handleInitTeamMemory}
									disabled={loading}
								>
									Initialize
								</button>
							)}
					</div>
					{!teamMemoryAvailable || !teamMemoryStatus ? (
						<div className="text-xs text-text-muted">
							Team memory is only available inside a git repository.
						</div>
					) : (
						<>
							<div className="text-xs text-text-secondary">
								<div>Repo: {teamMemoryStatus.projectName}</div>
								<div>Entrypoint: {teamMemoryStatus.entrypoint}</div>
								<div>
									Status:{" "}
									{teamMemoryStatus.exists ? "initialized" : "not initialized"}
								</div>
								<div>Files: {teamMemoryStatus.fileCount}</div>
							</div>
							{teamMemoryStatus.files.length > 0 && (
								<div className="text-[11px] text-text-muted">
									Files: {teamMemoryStatus.files.slice(0, 4).join(", ")}
								</div>
							)}
						</>
					)}
				</div>

				<div className="grid grid-cols-[220px,minmax(0,1fr)] gap-4">
					<div className="space-y-4">
						<div className="space-y-2">
							<div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
								Save memory
							</div>
							<input
								aria-label="Memory topic"
								type="text"
								value={saveTopic}
								onChange={(event) => updateSaveTopic(event.currentTarget.value)}
								onInput={(event) => updateSaveTopic(event.currentTarget.value)}
								placeholder="api-design"
								className="w-full bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
							/>
							<textarea
								aria-label="Memory content"
								value={saveContent}
								onChange={(event) =>
									updateSaveContent(event.currentTarget.value)
								}
								onInput={(event) =>
									updateSaveContent(event.currentTarget.value)
								}
								placeholder="Use REST conventions #rest"
								rows={4}
								className="w-full bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
							/>
							<button
								type="button"
								className="w-full px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
								onClick={handleSave}
								disabled={loading}
							>
								Save memory
							</button>
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between gap-2">
								<div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide">
									Topics
								</div>
								<button
									type="button"
									className="px-2 py-1 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
									onClick={handleShowRecent}
									disabled={loading}
								>
									Recent
								</button>
							</div>
							<div className="max-h-56 overflow-y-auto space-y-2 pr-1">
								{topics.length === 0 ? (
									<div className="text-xs text-text-muted">
										No topics saved yet.
									</div>
								) : (
									topics.map((topic) => (
										<button
											key={topic.name}
											type="button"
											aria-label={`Show memories for topic ${topic.name}`}
											className="w-full text-left px-3 py-2 rounded-lg border border-line-subtle hover:bg-bg-tertiary/60"
											onClick={() => handleTopicSelect(topic.name)}
											disabled={loading}
										>
											<div className="text-xs text-text-primary font-medium">
												{topic.name}
											</div>
											<div className="text-[11px] text-text-muted">
												{topic.entryCount}{" "}
												{topic.entryCount === 1 ? "entry" : "entries"} ·{" "}
												{formatMemoryRelativeTime(topic.lastUpdated)}
											</div>
										</button>
									))
								)}
							</div>
						</div>

						<div className="space-y-2">
							<label className="inline-flex items-center gap-2 text-xs text-text-tertiary">
								<input
									aria-label="Confirm clear all memories"
									type="checkbox"
									checked={clearConfirmed}
									onChange={(event) => setClearConfirmed(event.target.checked)}
									className="h-4 w-4 rounded border-line-subtle bg-bg-tertiary text-accent focus:ring-accent"
								/>
								<span>Confirm clear all</span>
							</label>
							<button
								type="button"
								className="w-full px-3 py-2 rounded-lg border border-error/40 text-xs text-error hover:bg-error/10 disabled:opacity-50"
								onClick={handleClear}
								disabled={loading || !clearConfirmed}
							>
								Clear all memories
							</button>
						</div>
					</div>

					<div className="space-y-3 min-w-0">
						<div className="flex items-center gap-2">
							<input
								aria-label="Search memories"
								type="text"
								value={searchQuery}
								onChange={(event) =>
									updateSearchQuery(event.currentTarget.value)
								}
								onInput={(event) =>
									updateSearchQuery(event.currentTarget.value)
								}
								placeholder="Search by topic, content, or tag"
								className="flex-1 bg-bg-tertiary border border-line-subtle rounded-lg px-3 py-2 text-xs text-text-primary"
							/>
							<button
								type="button"
								className="px-3 py-2 rounded-lg border border-line-subtle text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
								onClick={handleSearch}
								disabled={loading}
							>
								Search
							</button>
						</div>

						<div className="text-xs text-text-muted">
							{viewLabel}
							{loading ? " · Loading…" : ""}
						</div>

						<div className="max-h-[28rem] overflow-y-auto space-y-2 pr-1">
							{entries.length === 0 ? (
								<div className="border border-line-subtle rounded-lg px-3 py-4 text-xs text-text-muted bg-bg-tertiary/40">
									No memories to display.
								</div>
							) : (
								entries.map((entry) => (
									<div
										key={entry.id}
										className="border border-line-subtle rounded-lg px-3 py-3 bg-bg-tertiary/30 space-y-2"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<div className="text-xs font-medium text-text-primary">
													{entry.topic}
												</div>
												<div className="text-[11px] text-text-muted">
													{entry.id} ·{" "}
													{formatMemoryRelativeTime(entry.updatedAt)}
												</div>
											</div>
											<button
												type="button"
												aria-label={`Delete memory ${entry.id}`}
												className="px-2 py-1 rounded-lg border border-line-subtle text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary/60 disabled:opacity-50"
												onClick={() => handleDelete(entry)}
												disabled={loading}
											>
												Delete
											</button>
										</div>
										<div className="text-xs text-text-secondary whitespace-pre-wrap break-words">
											{truncateMemoryText(entry.content, 240)}
										</div>
										{entry.tags && entry.tags.length > 0 && (
											<div className="text-[11px] text-text-muted">
												Tags: {entry.tags.join(", ")}
											</div>
										)}
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
