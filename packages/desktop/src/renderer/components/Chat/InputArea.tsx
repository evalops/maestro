/**
 * InputArea Component
 *
 * Premium chat input with glowing border effect.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface InputAreaProps {
	onSend: (content: string) => void;
	disabled?: boolean;
	placeholder?: string;
}

export function InputArea({
	onSend,
	disabled = false,
	placeholder = "Ask anything...",
}: InputAreaProps) {
	const [value, setValue] = useState("");
	const [isFocused, setIsFocused] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-resize textarea
	const adjustHeight = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		textarea.style.height = "auto";
		const newHeight = Math.min(textarea.scrollHeight, 200);
		textarea.style.height = `${newHeight}px`;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally resize when value changes
	useEffect(() => {
		adjustHeight();
	}, [value, adjustHeight]);

	const handleSubmit = () => {
		if (!value.trim() || disabled) return;
		onSend(value);
		setValue("");
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	const canSend = value.trim().length > 0 && !disabled;

	return (
		<div className="space-y-3">
			{/* Input container with glow effect */}
			<div className="input-area">
				<div
					className={`relative flex items-end gap-3 rounded-2xl p-4 transition-all duration-300 ${
						isFocused ? "" : ""
					}`}
					style={{
						background: isFocused
							? "linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%)"
							: "linear-gradient(180deg, rgba(12, 12, 18, 0.6) 0%, rgba(20, 20, 25, 0.4) 100%)",
						border: `1px solid ${isFocused ? "rgba(20, 184, 166, 0.4)" : "var(--border-subtle)"}`,
						boxShadow: isFocused
							? "0 0 0 3px var(--accent-subtle), 0 8px 32px -8px rgba(0, 0, 0, 0.4), 0 0 40px -10px var(--accent-glow)"
							: "0 4px 16px -4px rgba(0, 0, 0, 0.2)",
					}}
				>
					{/* Textarea */}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={() => setIsFocused(true)}
						onBlur={() => setIsFocused(false)}
						placeholder={placeholder}
						disabled={disabled}
						rows={1}
						className="flex-1 resize-none bg-transparent text-text-primary placeholder:text-text-muted
							focus:outline-none text-[15px] leading-relaxed max-h-[200px] py-1"
						style={{ letterSpacing: "-0.01em" }}
					/>

					{/* Actions */}
					<div className="flex items-center gap-2">
						{/* Attachment button */}
						<button
							type="button"
							className="p-2.5 rounded-xl text-text-muted hover:text-text-secondary hover:bg-bg-elevated/50
								transition-all duration-200 disabled:opacity-40"
							disabled={disabled}
							title="Attach file"
						>
							<svg
								aria-hidden="true"
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
							</svg>
						</button>

						{/* Send button */}
						<button
							type="button"
							onClick={handleSubmit}
							disabled={!canSend}
							className={`p-2.5 rounded-xl transition-all duration-300 ${
								canSend
									? "bg-accent text-white hover:bg-accent-hover hover:-translate-y-0.5 active:translate-y-0"
									: "text-text-muted bg-bg-tertiary/30"
							}`}
							style={
								canSend
									? {
											boxShadow:
												"0 4px 16px -4px var(--accent-glow), 0 0 20px -8px var(--accent-glow)",
										}
									: {}
							}
							title="Send message"
						>
							<svg
								aria-hidden="true"
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className={canSend ? "translate-x-0.5 -translate-y-0.5" : ""}
							>
								<line x1="22" y1="2" x2="11" y2="13" />
								<polygon points="22 2 15 22 11 13 2 9 22 2" />
							</svg>
						</button>
					</div>
				</div>
			</div>

			{/* Hints */}
			<div className="flex items-center justify-between px-2 text-[10px] text-text-muted">
				<div className="flex items-center gap-1.5">
					<kbd className="px-1.5 py-0.5 bg-bg-tertiary/30 rounded-md text-text-tertiary font-mono text-[9px] border border-line-subtle/50">
						↵
					</kbd>
					<span className="uppercase tracking-wider">send</span>
					<span className="text-text-muted/30 mx-1.5">|</span>
					<kbd className="px-1.5 py-0.5 bg-bg-tertiary/30 rounded-md text-text-tertiary font-mono text-[9px] border border-line-subtle/50">
						⇧↵
					</kbd>
					<span className="uppercase tracking-wider">new line</span>
				</div>
				{value.length > 0 && (
					<span className="font-mono tabular-nums text-text-tertiary">
						{value.length.toLocaleString()}
					</span>
				)}
			</div>
		</div>
	);
}
