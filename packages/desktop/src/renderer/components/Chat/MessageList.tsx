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
}

export function MessageList({ messages, isLoading = false }: MessageListProps) {
	return (
		<div className="space-y-8">
			{messages.map((message, index) => (
				<Message
					key={message.id ?? index}
					role={message.role}
					content={message.content}
					toolCalls={message.toolCalls}
					timestamp={message.timestamp}
					isStreaming={
						isLoading &&
						index === messages.length - 1 &&
						message.role === "assistant"
					}
				/>
			))}

			{/* Thinking indicator */}
			{isLoading && messages[messages.length - 1]?.role === "user" && (
				<div className="flex items-start gap-4 animate-slide-up">
					<div
						className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0
							bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20"
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
								Composer
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
