/**
 * ChatContainer Component
 *
 * Premium chat interface with elegant empty states and interactions.
 */

import {
	getActiveComposerProjectOnboardingSteps,
	getComposerProjectOnboardingActions,
	getComposerResumableSessions,
	normalizeComposerResumeSummary,
	truncateComposerResumeSummary,
} from "@evalops/contracts";
import { useEffect, useRef, useState } from "react";
import { useChat } from "../../hooks/useChat";
import { apiClient } from "../../lib/api-client";
import type {
	SessionSummary,
	ThinkingLevel,
	WorkspaceStatus,
} from "../../lib/types";
import { InputArea } from "./InputArea";
import { MessageList } from "./MessageList";

export interface ChatContainerProps {
	sessionId: string | null;
	sessions?: SessionSummary[];
	showTimestamps?: boolean;
	density?: "comfortable" | "compact";
	thinkingLevel?: ThinkingLevel;
	workspaceStatusPrefetch?: WorkspaceStatus | null;
	onSessionSelect?: (sessionId: string) => void;
}

export function ChatContainer({
	sessionId,
	sessions = [],
	showTimestamps = true,
	density = "comfortable",
	thinkingLevel = "off",
	workspaceStatusPrefetch = null,
	onSessionSelect,
}: ChatContainerProps) {
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [workspaceStatus, setWorkspaceStatus] =
		useState<WorkspaceStatus | null>(workspaceStatusPrefetch);
	const { messages, isLoading, error, runtimeStatus, sendMessage, clearError } =
		useChat(sessionId ?? undefined, { thinkingLevel });
	const onboardingSteps = getActiveComposerProjectOnboardingSteps(
		workspaceStatus?.onboarding,
	);
	const onboardingActions = getComposerProjectOnboardingActions(
		workspaceStatus?.onboarding,
	);
	const recentSessions = getComposerResumableSessions(sessions, {
		excludeSessionId: sessionId,
		limit: 6,
	});

	// Auto-scroll to bottom when new messages arrive
	// biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally scroll when messages change
	useEffect(() => {
		if (messagesEndRef.current) {
			messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages]);

	useEffect(() => {
		setWorkspaceStatus(workspaceStatusPrefetch);
	}, [workspaceStatusPrefetch]);

	useEffect(() => {
		if (workspaceStatusPrefetch !== null) {
			return;
		}
		let cancelled = false;
		void apiClient.getStatus().then((status) => {
			if (!cancelled) {
				setWorkspaceStatus(status);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceStatusPrefetch]);

	useEffect(() => {
		if (onboardingSteps.length === 0) {
			return;
		}
		void apiClient.markProjectOnboardingSeen().catch(() => {});
	}, [onboardingSteps.length]);

	const handleSendMessage = async (content: string) => {
		if (!content.trim()) return;
		await sendMessage(content);
	};

	const formatSessionDate = (dateString: string) => {
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

	if (!sessionId) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="empty-state animate-fade-in">
					<div className="empty-state-icon">
						<svg
							aria-hidden="true"
							width="32"
							height="32"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
						</svg>
					</div>
					<h2 className="text-title text-text-primary mb-2">
						Welcome to Maestro
					</h2>
					<p className="text-sm text-text-secondary max-w-sm">
						Start a new session to begin chatting with your AI assistant.
					</p>
					{onboardingSteps.length > 0 ? (
						<div
							className="mt-6 max-w-md rounded-2xl px-5 py-4 text-left"
							style={{
								background:
									"linear-gradient(135deg, rgba(20, 184, 166, 0.08) 0%, rgba(245, 158, 11, 0.05) 100%)",
								border: "1px solid rgba(20, 184, 166, 0.18)",
							}}
						>
							<div className="text-xs font-semibold tracking-[0.18em] uppercase text-text-secondary mb-2">
								Getting Started
							</div>
							<ul className="m-0 pl-5 text-sm text-text-primary space-y-2">
								{onboardingSteps.map((step) => (
									<li key={step.key}>{step.text}</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Messages Area */}
			<div className="flex-1 overflow-y-auto">
				<div className="max-w-3xl mx-auto px-6 py-8">
					{messages.length === 0 ? (
						<div className="flex flex-col items-center justify-center min-h-[50vh] text-center animate-fade-in">
							{/* Geometric hero illustration */}
							<div className="relative w-28 h-28 mb-10">
								{/* Outer ring */}
								<div
									className="absolute inset-0 rounded-full animate-glow-pulse"
									style={{
										background:
											"linear-gradient(135deg, transparent 0%, var(--accent-subtle) 50%, transparent 100%)",
										border: "1px solid rgba(20, 184, 166, 0.2)",
									}}
								/>
								{/* Inner shape */}
								<div
									className="absolute inset-4 rounded-2xl flex items-center justify-center"
									style={{
										background:
											"linear-gradient(135deg, var(--accent) 0%, var(--accent-muted) 100%)",
										boxShadow: "0 8px 32px -8px var(--accent-glow)",
									}}
								>
									<svg
										aria-hidden="true"
										width="36"
										height="36"
										viewBox="0 0 24 24"
										fill="none"
										stroke="white"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M12 2L2 7l10 5 10-5-10-5z" />
										<path d="M2 17l10 5 10-5" />
										<path d="M2 12l10 5 10-5" />
									</svg>
								</div>
								{/* Decorative dots */}
								<div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-accent/40" />
								<div className="absolute -bottom-2 -left-2 w-2 h-2 rounded-full bg-accent/30" />
							</div>

							<h2 className="text-headline text-text-primary mb-4">
								How can I help?
							</h2>
							<p className="text-[15px] text-text-secondary max-w-md mb-12 leading-relaxed">
								Your AI coding assistant. Write code, debug issues, explain
								concepts, or tackle any programming challenge.
							</p>
							{onboardingSteps.length > 0 ? (
								<div
									className="mb-10 w-full max-w-xl rounded-2xl px-5 py-4 text-left"
									style={{
										background:
											"linear-gradient(135deg, rgba(20, 184, 166, 0.08) 0%, rgba(245, 158, 11, 0.05) 100%)",
										border: "1px solid rgba(20, 184, 166, 0.18)",
									}}
								>
									<div className="text-xs font-semibold tracking-[0.18em] uppercase text-text-secondary mb-2">
										Getting Started
									</div>
									<ul className="m-0 pl-5 text-sm text-text-primary space-y-2">
										{onboardingSteps.map((step) => (
											<li key={step.key}>{step.text}</li>
										))}
									</ul>
									{onboardingActions.length > 0 ? (
										<div className="mt-4 flex flex-wrap gap-3">
											{onboardingActions.map((action) => (
												<button
													type="button"
													key={action.id}
													onClick={() => handleSendMessage(action.value)}
													className="px-3.5 py-2 rounded-xl text-xs font-mono transition-colors"
													style={{
														background: "var(--bg-secondary)",
														border:
															action.kind === "command"
																? "1px solid rgba(245, 158, 11, 0.24)"
																: "1px solid rgba(20, 184, 166, 0.24)",
														color: "var(--text-primary)",
													}}
												>
													{action.label}
												</button>
											))}
										</div>
									) : null}
								</div>
							) : null}

							{recentSessions.length > 0 && onSessionSelect ? (
								<div className="mb-10 w-full max-w-3xl text-left">
									<div className="text-xs font-semibold tracking-[0.18em] uppercase text-text-secondary mb-3">
										Resume a Session
									</div>
									<div className="grid gap-3 md:grid-cols-2">
										{recentSessions.map((session) => {
											const resumeSummary = normalizeComposerResumeSummary(
												session.resumeSummary,
											);
											return (
												<button
													type="button"
													key={session.id}
													onClick={() => onSessionSelect(session.id)}
													className="rounded-2xl px-4 py-4 text-left transition-colors"
													style={{
														background: "var(--bg-secondary)",
														border: "1px solid var(--border-subtle)",
													}}
												>
													<div className="text-sm font-medium text-text-primary">
														{session.title ||
															`Session ${session.id.slice(0, 8)}`}
													</div>
													<div className="mt-1 text-[11px] text-text-muted">
														{session.messageCount} msg · Updated{" "}
														{formatSessionDate(session.updatedAt)}
													</div>
													{resumeSummary ? (
														<div className="mt-2 text-xs leading-relaxed text-text-secondary">
															{truncateComposerResumeSummary(
																resumeSummary,
																110,
															)}
														</div>
													) : null}
												</button>
											);
										})}
									</div>
								</div>
							) : null}

							{/* Quick action chips */}
							<div className="flex flex-wrap justify-center gap-3 max-w-xl">
								{[
									{ label: "Write code", icon: "code", color: "teal" },
									{ label: "Debug issue", icon: "bug", color: "amber" },
									{ label: "Explain concept", icon: "book", color: "teal" },
									{ label: "Refactor", icon: "refresh", color: "teal" },
								].map((action, index) => (
									<button
										type="button"
										key={action.label}
										onClick={() =>
											handleSendMessage(`Help me ${action.label.toLowerCase()}`)
										}
										className="group relative flex items-center gap-2.5 px-5 py-2.5 rounded-xl
											text-sm font-medium text-text-secondary
											hover:text-text-primary
											transition-all duration-300 hover:-translate-y-0.5"
										style={{
											background:
												"linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-secondary) 100%)",
											border: "1px solid var(--border-subtle)",
											animationDelay: `${index * 100}ms`,
										}}
									>
										{/* Hover glow overlay */}
										<div
											className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
											style={{
												background:
													action.color === "amber"
														? "linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, transparent 100%)"
														: "linear-gradient(135deg, rgba(20, 184, 166, 0.1) 0%, transparent 100%)",
												border:
													action.color === "amber"
														? "1px solid rgba(245, 158, 11, 0.2)"
														: "1px solid rgba(20, 184, 166, 0.2)",
											}}
										/>
										<span
											className={`relative z-10 transition-colors duration-200 ${
												action.color === "amber"
													? "group-hover:text-amber-400"
													: "group-hover:text-accent"
											}`}
										>
											{action.icon === "code" && (
												<svg
													aria-hidden="true"
													width="15"
													height="15"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
												>
													<polyline points="16 18 22 12 16 6" />
													<polyline points="8 6 2 12 8 18" />
												</svg>
											)}
											{action.icon === "bug" && (
												<svg
													aria-hidden="true"
													width="15"
													height="15"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
												>
													<circle cx="12" cy="12" r="10" />
													<line x1="12" y1="8" x2="12" y2="12" />
													<line x1="12" y1="16" x2="12.01" y2="16" />
												</svg>
											)}
											{action.icon === "book" && (
												<svg
													aria-hidden="true"
													width="15"
													height="15"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
												>
													<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
													<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
												</svg>
											)}
											{action.icon === "refresh" && (
												<svg
													aria-hidden="true"
													width="15"
													height="15"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
												>
													<path d="M21 2v6h-6" />
													<path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
													<path d="M3 22v-6h6" />
													<path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
												</svg>
											)}
										</span>
										<span className="relative z-10">{action.label}</span>
									</button>
								))}
							</div>
						</div>
					) : (
						<>
							<MessageList
								messages={messages}
								isLoading={isLoading}
								showTimestamps={showTimestamps}
								density={density}
							/>
							<div ref={messagesEndRef} className="h-4" />
						</>
					)}
				</div>
			</div>

			{runtimeStatus && (
				<div
					className="flex-shrink-0 px-4 py-2 animate-slide-up"
					style={{
						background:
							"linear-gradient(180deg, rgba(20, 184, 166, 0.08) 0%, transparent 100%)",
						borderTop: "1px solid rgba(20, 184, 166, 0.18)",
					}}
				>
					<div className="max-w-3xl mx-auto flex items-center gap-3 text-accent">
						<div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
						<span className="text-xs font-medium tracking-wide uppercase">
							Agent
						</span>
						<span className="text-sm text-text-primary normal-case tracking-normal">
							{runtimeStatus}
						</span>
					</div>
				</div>
			)}

			{/* Error Banner */}
			{error && (
				<div
					className="flex-shrink-0 px-4 py-3 animate-slide-up"
					style={{
						background:
							"linear-gradient(180deg, var(--error-glow) 0%, transparent 100%)",
						borderTop: "1px solid rgba(239, 68, 68, 0.2)",
					}}
				>
					<div className="max-w-3xl mx-auto flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="w-5 h-5 rounded-full bg-error/20 flex items-center justify-center">
								<svg
									aria-hidden="true"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="var(--error)"
									strokeWidth="2"
								>
									<circle cx="12" cy="12" r="10" />
									<line x1="15" y1="9" x2="9" y2="15" />
									<line x1="9" y1="9" x2="15" y2="15" />
								</svg>
							</div>
							<span className="text-sm text-error">{error}</span>
						</div>
						<button
							type="button"
							onClick={clearError}
							className="p-1 rounded-lg text-error/60 hover:text-error hover:bg-error/10 transition-colors"
						>
							<svg
								aria-hidden="true"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</div>
			)}

			{/* Input Area */}
			<div
				className="flex-shrink-0 p-4"
				style={{
					background:
						"linear-gradient(180deg, transparent 0%, var(--bg-primary) 20%)",
				}}
			>
				<div className="max-w-3xl mx-auto">
					<InputArea onSend={handleSendMessage} disabled={isLoading} />
				</div>
			</div>
		</div>
	);
}
