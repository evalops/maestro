/**
 * Sidebar Component
 *
 * Premium session list with elegant interactions.
 */

import {
	normalizeComposerResumeSummary,
	truncateComposerResumeSummary,
} from "@evalops/contracts";
import { useState } from "react";
import type { SessionSummary } from "../../lib/types";

export interface SidebarProps {
	open: boolean;
	activeView: "chat" | "automations";
	sessions: SessionSummary[];
	currentSessionId: string | null;
	onSessionSelect: (sessionId: string) => void;
	onSessionDelete: (sessionId: string) => void;
	onNewSession: () => void;
	onViewChange: (view: "chat" | "automations") => void;
	onOpenSettings: () => void;
}

export function Sidebar({
	open,
	activeView,
	sessions,
	currentSessionId,
	onSessionSelect,
	onSessionDelete,
	onNewSession,
	onViewChange,
	onOpenSettings,
}: SidebarProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [hoveredSession, setHoveredSession] = useState<string | null>(null);

	const filteredSessions = sessions.filter((session) => {
		if (!searchQuery) {
			return true;
		}
		const normalizedQuery = searchQuery.toLowerCase();
		const normalizedSummary = normalizeComposerResumeSummary(
			session.resumeSummary,
		)?.toLowerCase();
		return (
			session.title?.toLowerCase().includes(normalizedQuery) ||
			normalizedSummary?.includes(normalizedQuery)
		);
	});

	const formatDate = (dateString: string) => {
		const date = new Date(dateString);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) {
			return "Today";
		}
		if (days === 1) {
			return "Yesterday";
		}
		if (days < 7) {
			return `${days}d ago`;
		}
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	};

	return (
		<aside
			className={`flex flex-col transition-all duration-300 ease-out-expo overflow-hidden ${
				open ? "w-[280px]" : "w-0"
			}`}
			style={{
				background:
					"linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-void) 100%)",
			}}
		>
			{/* New Session Button */}
			<div className="flex-shrink-0 p-4 pt-5">
				<button
					type="button"
					onClick={onNewSession}
					className="group w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl
						bg-accent text-white font-medium text-sm
						hover:bg-accent-hover transition-all duration-300
						shadow-[0_4px_20px_-4px_var(--accent-glow)] hover:shadow-[0_8px_30px_-4px_var(--accent-glow)]
						active:scale-[0.97] hover:-translate-y-0.5"
				>
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="transition-transform duration-300 group-hover:rotate-90"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					New Session
				</button>
			</div>

			{/* Search */}
			<div className="flex-shrink-0 px-4 pb-3">
				<div className="relative group">
					<svg
						aria-hidden="true"
						className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted transition-colors group-focus-within:text-accent"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth="2"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search sessions..."
						className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl
							bg-bg-tertiary/30 border border-transparent
							text-text-primary placeholder:text-text-muted
							focus:outline-none focus:border-accent/40 focus:bg-bg-tertiary/60
							focus:shadow-[0_0_0_3px_var(--accent-subtle)]
							transition-all duration-200"
					/>
				</div>
			</div>

			{/* Workspace */}
			<div className="flex-shrink-0 px-4 pb-3">
				<div className="text-[11px] uppercase tracking-[0.2em] text-text-tertiary mb-2">
					Workspace
				</div>
				<button
					type="button"
					onClick={() => onViewChange("automations")}
					className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all ${
						activeView === "automations"
							? "bg-bg-tertiary/70 text-text-primary border border-accent/30 shadow-[0_8px_20px_-16px_rgba(20,184,166,0.8)]"
							: "bg-bg-tertiary/30 text-text-muted hover:text-text-primary hover:bg-bg-tertiary/60"
					}`}
				>
					<span className="w-8 h-8 rounded-lg bg-bg-secondary/70 border border-border-subtle flex items-center justify-center">
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M12 8v5l3 2" />
							<circle cx="12" cy="12" r="9" />
						</svg>
					</span>
					<div className="flex-1 text-left">
						<div className="font-medium">Automations</div>
						<div className="text-[11px] text-text-tertiary">
							Scheduled agent runs
						</div>
					</div>
				</button>
			</div>

			{/* Sessions List */}
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{filteredSessions.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-center p-6">
						<div className="w-14 h-14 rounded-2xl bg-bg-tertiary/50 flex items-center justify-center mb-4">
							<svg
								aria-hidden="true"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="text-text-muted"
							>
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
							</svg>
						</div>
						<p className="text-sm font-medium text-text-secondary mb-1">
							{searchQuery ? "No results" : "No sessions yet"}
						</p>
						<p className="text-xs text-text-muted">
							{searchQuery ? "Try different keywords" : "Start a conversation"}
						</p>
					</div>
				) : (
					<div className="space-y-0.5">
						{filteredSessions.map((session, index) => (
							<button
								type="button"
								key={session.id}
								className={`session-item w-full text-left ${
									currentSessionId === session.id ? "active" : ""
								}`}
								style={{
									animationDelay: `${index * 30}ms`,
								}}
								onMouseEnter={() => setHoveredSession(session.id)}
								onMouseLeave={() => setHoveredSession(null)}
								onClick={() => onSessionSelect(session.id)}
							>
								<div className="flex items-start gap-3">
									<div
										className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
											currentSessionId === session.id
												? "bg-accent"
												: "bg-text-muted"
										}`}
									/>
									<div className="flex-1 min-w-0">
										<div
											className={`session-title font-medium text-sm truncate transition-colors ${
												currentSessionId === session.id
													? "text-accent-hover"
													: "text-text-primary"
											}`}
										>
											{session.title || "Untitled"}
										</div>
										<div className="flex items-center gap-1.5 mt-0.5">
											<span className="text-[11px] text-text-muted">
												{formatDate(session.createdAt)}
											</span>
											{session.messageCount > 0 && (
												<>
													<span className="text-text-muted/50">·</span>
													<span className="text-[11px] text-text-muted">
														{session.messageCount} msg
													</span>
												</>
											)}
										</div>
										{normalizeComposerResumeSummary(session.resumeSummary) ? (
											<div className="mt-1 text-[11px] leading-relaxed text-text-muted">
												{truncateComposerResumeSummary(
													normalizeComposerResumeSummary(
														session.resumeSummary,
													)!,
													96,
												)}
											</div>
										) : null}
									</div>

									{/* Delete button */}
									{hoveredSession === session.id && (
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												onSessionDelete(session.id);
											}}
											className="p-1 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-all duration-150"
											title="Delete"
										>
											<svg
												aria-hidden="true"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<polyline points="3 6 5 6 21 6" />
												<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
											</svg>
										</button>
									)}
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="flex-shrink-0 px-4 py-4 border-t border-line-subtle/50">
				<div className="flex items-center justify-between text-label text-text-muted">
					<span>
						{sessions.length} session{sessions.length !== 1 ? "s" : ""}
					</span>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onOpenSettings}
							className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
							title="Settings"
						>
							<svg
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<circle cx="12" cy="12" r="3" />
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.82V22a2 2 0 1 1-4 0v-.08A1.65 1.65 0 0 0 9 20.6a1.65 1.65 0 0 0-1-.6 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.82-.33H2a2 2 0 1 1 0-4h.08A1.65 1.65 0 0 0 3.4 9a1.65 1.65 0 0 0 .6-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6c.3 0 .6-.1 1-.6a1.65 1.65 0 0 0 .33-1.82V2a2 2 0 1 1 4 0v.08a1.65 1.65 0 0 0 .33 1.82c.4.5.7.6 1 .6a1.65 1.65 0 0 0 1-.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c0 .3.1.6.6 1a1.65 1.65 0 0 0 1.82.33H22a2 2 0 1 1 0 4h-.08a1.65 1.65 0 0 0-1.82.33c-.5.4-.6.7-.6 1z" />
							</svg>
						</button>
						<span className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-bg-tertiary/50">
							v0.10.0
						</span>
					</div>
				</div>
			</div>
		</aside>
	);
}
