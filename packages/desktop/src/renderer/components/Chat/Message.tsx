/**
 * Message Component
 *
 * Renders a single chat message with markdown support.
 */

import { useState } from "react";
import { summarizeDesktopToolCalls } from "../../lib/tool-summary";
import type { ToolCall as ToolCallType } from "../../lib/types";
import { Markdown } from "../common";
import { ToolCall } from "./ToolCall";

export interface MessageProps {
	role: "user" | "assistant";
	content: string;
	thinking?: string;
	toolCalls?: ToolCallType[];
	timestamp?: string;
	showTimestamp?: boolean;
	density?: "comfortable" | "compact";
	isStreaming?: boolean;
}

export function Message({
	role,
	content,
	thinking,
	toolCalls,
	timestamp,
	showTimestamp = true,
	density = "comfortable",
	isStreaming = false,
}: MessageProps) {
	const isUser = role === "user";
	const isCompact = density === "compact";
	const [isThinkingOpen, setIsThinkingOpen] = useState(false);
	const hasThinking = thinking !== undefined;
	const thinkingContent = (thinking ?? "").trim();
	const hasThinkingContent = thinkingContent.length > 0;
	const toolSummaryLabels = toolCalls
		? summarizeDesktopToolCalls(toolCalls)
		: [];

	const formatTime = (dateString?: string) => {
		if (!dateString) return "";
		const date = new Date(dateString);
		return date.toLocaleTimeString(undefined, {
			hour: "numeric",
			minute: "2-digit",
		});
	};

	const getThinkingSummary = () => {
		if (!hasThinkingContent) return "Thinking...";
		const firstLine = thinkingContent.split("\n")[0] ?? "";
		if (firstLine.length <= 120) return firstLine;
		return `${firstLine.slice(0, 120)}...`;
	};

	return (
		<div
			className={`flex items-start ${isCompact ? "gap-3" : "gap-4"} animate-slide-up ${
				isUser ? "flex-row-reverse" : ""
			}`}
		>
			{/* Avatar */}
			<div
				className={`flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:scale-105 ${
					isCompact ? "w-8 h-8 rounded-lg" : "w-10 h-10 rounded-xl"
				} ${isUser ? "" : ""}`}
				style={
					isUser
						? {
								background:
									"linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-elevated) 100%)",
								border: "1px solid var(--border-subtle)",
							}
						: {
								background:
									"linear-gradient(135deg, rgba(20, 184, 166, 0.15) 0%, rgba(20, 184, 166, 0.05) 100%)",
								border: "1px solid rgba(20, 184, 166, 0.2)",
								boxShadow: "0 0 20px -5px rgba(20, 184, 166, 0.2)",
							}
				}
			>
				{isUser ? (
					<svg
						aria-hidden="true"
						className="w-4 h-4 text-text-secondary"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
						/>
					</svg>
				) : (
					<svg
						aria-hidden="true"
						className="w-4 h-4 text-accent"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M12 2L2 7l10 5 10-5-10-5z"
						/>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M2 17l10 5 10-5"
						/>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M2 12l10 5 10-5"
						/>
					</svg>
				)}
			</div>

			{/* Content */}
			<div
				className={`flex-1 min-w-0 max-w-[85%] ${isUser ? "flex flex-col items-end" : ""}`}
			>
				{/* Header */}
				<div
					className={`flex items-center ${
						isCompact ? "gap-2 mb-2" : "gap-2.5 mb-2.5"
					} ${isUser ? "justify-end" : ""}`}
				>
					<span className="text-label text-text-secondary">
						{isUser ? "You" : "Maestro"}
					</span>
					{timestamp && showTimestamp && (
						<span className="text-[10px] text-text-muted font-mono tabular-nums">
							{formatTime(timestamp)}
						</span>
					)}
					{isStreaming && (
						<div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/10">
							<div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
							<span className="text-[10px] text-accent font-semibold uppercase tracking-wide">
								Generating
							</span>
						</div>
					)}
				</div>

				{/* Thinking Block */}
				{!isUser && hasThinking && (
					<div
						className={`thinking-block ${isThinkingOpen ? "open" : "collapsed"} ${
							isCompact ? "compact" : ""
						}`}
					>
						<button
							type="button"
							className="thinking-header"
							aria-expanded={isThinkingOpen}
							onClick={() => setIsThinkingOpen((prev) => !prev)}
						>
							<div className="thinking-label">
								<span
									className="thinking-dot animate-pulse"
									aria-hidden="true"
								/>
								<span>{isStreaming ? "Thinking..." : "Reasoning"}</span>
							</div>
							<span className="thinking-toggle" aria-hidden="true">
								▾
							</span>
						</button>
						{!isThinkingOpen && hasThinkingContent && (
							<div className="thinking-summary">{getThinkingSummary()}</div>
						)}
						<div
							className={`thinking-content ${
								isThinkingOpen ? "open" : "collapsed"
							}`}
						>
							{hasThinkingContent ? thinkingContent : "Thinking..."}
						</div>
					</div>
				)}

				{/* Message Content */}
				<div
					className={`transition-all duration-200 ${
						isCompact ? "px-4 py-3" : "px-5 py-4"
					} ${isUser ? "message-user" : "message-assistant"}`}
				>
					{isUser ? (
						<p
							className={`whitespace-pre-wrap leading-relaxed ${
								isCompact ? "text-[14px]" : "text-[15px]"
							}`}
						>
							{content}
						</p>
					) : (
						<div className="markdown-content">
							<Markdown content={content} />
						</div>
					)}
				</div>

				{/* Tool Calls */}
				{toolCalls && toolCalls.length > 0 && (
					<div className="mt-4 space-y-3 w-full">
						{toolSummaryLabels.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{toolSummaryLabels.map((label) => (
									<span
										key={label}
										className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary border border-line-subtle bg-bg-elevated"
									>
										{label}
									</span>
								))}
							</div>
						)}
						{toolCalls.map((toolCall, index) => (
							<ToolCall
								key={toolCall.id ?? index}
								name={toolCall.name}
								args={toolCall.args}
								status={toolCall.status}
								result={toolCall.result}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
