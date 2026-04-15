import {
	getActiveComposerProjectOnboardingSteps,
	getComposerProjectOnboardingActions,
	getComposerResumableSessions,
	normalizeComposerResumeSummary,
	truncateComposerResumeSummary,
} from "@evalops/contracts";
import { type TemplateResult, html, nothing } from "lit";
import type {
	SessionSummary,
	WorkspaceStatus,
} from "../services/api-client.js";
import { summarizeWebToolCalls } from "../services/tool-summary.js";
import type {
	MessageWithThinking,
	UiMessage,
} from "./composer-chat-stream-state.js";

export type ComposerChatViewportOptions = {
	windowStart: number;
	windowEnd: number;
	virtualStartIndex: number;
	virtualEndIndex: number;
	virtualPaddingTop: number;
	virtualPaddingBottom: number;
	virtualizationMinMessages: number;
};

export type ComposerChatViewport = {
	totalMessages: number;
	visibleCount: number;
	hiddenOldCount: number;
	hiddenNewCount: number;
	renderedStartIndex: number;
	renderedMessages: UiMessage[];
	topSpacerHeight: number;
	bottomSpacerHeight: number;
};

export type ComposerChatMessagePaneProps = {
	messages: UiMessage[];
	loading: boolean;
	loadingEarlier: boolean;
	unseenMessages: number;
	compactMode: boolean;
	cleanMode: "off" | "soft" | "aggressive";
	reducedMotion: boolean;
	isShared: boolean;
	cwd: string;
	gitBranch: string;
	gitSummary: string;
	currentModel: string;
	currentModelTokens: string | null;
	currentSessionId: string | null;
	totalCost: string | null;
	status: WorkspaceStatus | null;
	sessions: SessionSummary[];
	viewport: ComposerChatViewport;
	onSubmitEntryAction: (value: string) => void | Promise<void>;
	onSelectSession: (sessionId: string) => void | Promise<void>;
	onLoadEarlierMessages: () => void | Promise<void>;
	onJumpToLatest: () => void;
};

export function buildComposerChatViewport(
	messages: UiMessage[],
	options: ComposerChatViewportOptions,
): ComposerChatViewport {
	const totalMessages = messages.length;
	const visibleMessages = messages.slice(
		options.windowStart,
		options.windowEnd,
	);
	const shouldVirtualize =
		options.windowEnd - options.windowStart >=
		options.virtualizationMinMessages;
	const resolvedVirtualStart =
		options.virtualStartIndex >= options.windowStart &&
		options.virtualStartIndex < options.windowEnd
			? options.virtualStartIndex
			: options.windowStart;
	const resolvedVirtualEnd =
		options.virtualEndIndex > resolvedVirtualStart &&
		options.virtualEndIndex <= options.windowEnd
			? options.virtualEndIndex
			: options.windowEnd;
	const virtualStartLocal = Math.max(
		0,
		resolvedVirtualStart - options.windowStart,
	);
	const virtualEndLocal = Math.max(
		virtualStartLocal,
		resolvedVirtualEnd - options.windowStart,
	);

	return {
		totalMessages,
		visibleCount: visibleMessages.length,
		hiddenOldCount: options.windowStart,
		hiddenNewCount: totalMessages - options.windowEnd,
		renderedStartIndex: shouldVirtualize
			? resolvedVirtualStart
			: options.windowStart,
		renderedMessages: shouldVirtualize
			? visibleMessages.slice(virtualStartLocal, virtualEndLocal)
			: visibleMessages,
		topSpacerHeight: shouldVirtualize ? options.virtualPaddingTop : 0,
		bottomSpacerHeight: shouldVirtualize ? options.virtualPaddingBottom : 0,
	};
}

function formatSessionDate(date: string): string {
	const value = new Date(date);
	const now = new Date();
	const diff = now.getTime() - value.getTime();
	const days = Math.floor(diff / (1000 * 60 * 60 * 24));

	if (days === 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return `${days} days ago`;
	return value.toLocaleDateString();
}

function renderEmptyState(props: ComposerChatMessagePaneProps): TemplateResult {
	const recentSessions = getComposerResumableSessions(props.sessions, {
		excludeSessionId: props.currentSessionId,
		limit: 8,
	});
	const onboardingSteps = getActiveComposerProjectOnboardingSteps(
		props.status?.onboarding,
	);
	const onboardingActions = getComposerProjectOnboardingActions(
		props.status?.onboarding,
	);
	const sessionLoading = props.loading && props.messages.length === 0;

	return html`
		<div class="empty-state">
			${sessionLoading ? html`<div class="loading">Loading session...</div>` : ""}
			<div class="workspace-panel">
				<div class="panel-section">
					<h3>Workspace</h3>
					<div class="panel-item active"><span>►</span>${props.cwd}</div>
					<div class="panel-item"><span>GIT:</span>${props.gitBranch}</div>
					<div class="panel-item"><span>FILES:</span>${props.gitSummary}</div>
				</div>
				<div class="panel-section">
					<h3>Model</h3>
					<div class="panel-item active">
						<span>►</span>${props.currentModel}
					</div>
					<div class="panel-item">
						<span>CTX:</span>${props.currentModelTokens ?? "loading…"}
					</div>
					<div class="panel-item"><span>MODE:</span>streaming</div>
				</div>
				<div class="panel-section">
					<h3>Session</h3>
					<div class="panel-item">
						<span>ID:</span>${props.currentSessionId?.slice(0, 8) || "new"}
					</div>
					<div class="panel-item"><span>MSGS:</span>0</div>
					${
						props.totalCost
							? html`<div class="panel-item">
								<span>COST:</span>${props.totalCost}
							</div>`
							: ""
					}
				</div>
			</div>
			${
				onboardingSteps.length > 0
					? html`
						<div class="onboarding-callout" aria-live="polite">
							<h3>Getting Started</h3>
							<p>Project setup still has a couple of missing pieces.</p>
							<ul class="onboarding-list">
								${onboardingSteps.map((step) => html`<li>${step.text}</li>`)}
							</ul>
							${
								onboardingActions.length > 0
									? html`
										<div class="onboarding-actions">
											${onboardingActions.map(
												(action) => html`
													<button
														type="button"
														class="onboarding-action ${
															action.kind === "command" ? "command" : ""
														}"
														@click=${() =>
															void props.onSubmitEntryAction(action.value)}
													>
														${action.label}
													</button>
												`,
											)}
										</div>
									`
									: ""
							}
						</div>
					`
					: ""
			}
			${
				!props.isShared && recentSessions.length > 0
					? html`
						<div class="session-gallery" aria-live="polite">
							<div class="session-gallery-header">
								<h3>Resume a Session</h3>
								<span>Select a recent Composer run to continue.</span>
							</div>
							<div class="session-grid">
								${recentSessions.map(
									(session) => html`
										<button
											type="button"
											class="session-card"
											@click=${() => void props.onSelectSession(session.id)}
										>
											<div class="session-card-title">
												${
													session.title ||
													`Session ${session.id?.slice(0, 8) || ""}`
												}
											</div>
											<div class="session-card-meta">
												<span>${session.messageCount || 0} msgs</span>
												<span>•</span>
												<span>Updated ${formatSessionDate(session.updatedAt)}</span>
											</div>
											${
												normalizeComposerResumeSummary(session.resumeSummary)
													? html`<div class="session-card-summary">
														${truncateComposerResumeSummary(
															normalizeComposerResumeSummary(
																session.resumeSummary,
															)!,
															110,
														)}
													</div>`
													: ""
											}
										</button>
									`,
								)}
							</div>
						</div>
					`
					: ""
			}
		</div>
	`;
}

function renderMessages(props: ComposerChatMessagePaneProps): TemplateResult {
	return html`
		${
			props.viewport.hiddenOldCount > 0
				? html`
					<div class="history-truncation" data-history-truncation>
						Showing ${props.viewport.visibleCount} of
						${props.viewport.totalMessages}${
							props.viewport.hiddenNewCount > 0
								? ` (+${props.viewport.hiddenNewCount} newer hidden)`
								: ""
						}.
						<button
							class="history-btn"
							@click=${props.onLoadEarlierMessages}
							?disabled=${props.loadingEarlier}
						>
							${props.loadingEarlier ? "Loading..." : "Load earlier"}
						</button>
					</div>
				`
				: nothing
		}
		${
			props.viewport.topSpacerHeight > 0
				? html`<div
					class="virtual-spacer"
					style="height: ${props.viewport.topSpacerHeight}px"
				></div>`
				: nothing
		}
		${props.viewport.renderedMessages.map((msg, index) => {
			const globalIndex = props.viewport.renderedStartIndex + index;
			const isStreaming =
				props.loading &&
				globalIndex === props.messages.length - 1 &&
				msg.role === "assistant";
			return html`
				<composer-message
					data-index=${globalIndex}
					role=${msg.role}
					content=${msg.content}
					timestamp=${msg.timestamp || ""}
					.attachments=${msg.attachments || []}
					.thinking=${(msg as MessageWithThinking).thinking || ""}
					.tools=${msg.tools || []}
					.toolSummaryLabels=${summarizeWebToolCalls(msg.tools || [])}
					.cleanMode=${props.cleanMode}
					.streaming=${isStreaming}
					.compact=${props.compactMode}
					.reducedMotion=${props.reducedMotion}
				></composer-message>
			`;
		})}
		${
			props.viewport.bottomSpacerHeight > 0
				? html`<div
					class="virtual-spacer"
					style="height: ${props.viewport.bottomSpacerHeight}px"
				></div>`
				: nothing
		}
		${
			props.unseenMessages > 0
				? html`
					<button class="jump-latest" @click=${props.onJumpToLatest}>
						${props.unseenMessages} new message${
							props.unseenMessages === 1 ? "" : "s"
						} — Jump to latest
					</button>
				`
				: nothing
		}
	`;
}

export function renderComposerChatMessagePane(
	props: ComposerChatMessagePaneProps,
): TemplateResult {
	if (props.messages.length === 0) {
		return renderEmptyState(props);
	}
	return renderMessages(props);
}
