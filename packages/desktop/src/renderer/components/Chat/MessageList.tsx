/**
 * MessageList Component
 *
 * Renders a list of chat messages.
 */

import type { Message as MessageType } from "../../lib/types";
import { Message, type MessageProps } from "./Message";

export interface MessageListProps {
	messages: MessageType[];
	isLoading?: boolean;
	showTimestamps?: boolean;
	density?: "comfortable" | "compact";
}

export function MessageList({
	messages,
	isLoading = false,
	showTimestamps = true,
	density = "comfortable",
}: MessageListProps) {
	const spacingClass = density === "compact" ? "space-y-4" : "space-y-8";

	return (
		<div className={spacingClass}>
			{messages.map((message, index) => (
				<Message
					key={message.id ?? index}
					role={message.role}
					content={message.content}
					thinking={message.thinking}
					toolCalls={message.toolCalls}
					timestamp={message.timestamp}
					showTimestamp={showTimestamps}
					density={density}
					isStreaming={
						isLoading &&
						index === messages.length - 1 &&
						message.role === "assistant"
					}
				/>
			))}

			{/* Thinking indicator */}
			{isLoading && messages[messages.length - 1]?.role === "user" && (
				<div
					className={`flex items-start animate-slide-up ${
						density === "compact" ? "gap-3" : "gap-4"
					}`}
				>
					<div
						className={`flex items-center justify-center flex-shrink-0 ${
							density === "compact"
								? "w-8 h-8 rounded-lg"
								: "w-9 h-9 rounded-xl"
						} bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20`}
					>
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
					</div>
					<div className="flex-1 py-2">
						<div className="flex items-center gap-2 mb-2">
							<span className="text-xs font-medium text-text-secondary tracking-wide uppercase">
								Maestro
							</span>
						</div>
						<div className="typing-indicator">
							<span />
							<span />
							<span />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
