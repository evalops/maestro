/**
 * InputArea Component
 *
 * Premium chat input with glowing border effect.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../lib/api-client";

interface McpToolItem {
	id: string;
	server: string;
	tool: string;
	label: string;
	description?: string;
}

interface MentionState {
	start: number;
	end: number;
	query: string;
}

function buildMcpToolName(server: string, tool: string): string {
	return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpToolName(tool)}`;
}

function sanitizeMcpToolName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sanitizeMcpName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function findMention(text: string, cursor: number): MentionState | null {
	if (cursor < 0 || cursor > text.length) return null;
	const beforeCursor = text.slice(0, cursor);
	const atIndex = beforeCursor.lastIndexOf("@");
	if (atIndex === -1) return null;

	if (atIndex > 0) {
		const prev = beforeCursor[atIndex - 1];
		if (prev && /[A-Za-z0-9_]/.test(prev)) return null;
	}

	const afterAt = text.slice(atIndex + 1, cursor);
	if (/\s/.test(afterAt)) return null;

	const rest = text.slice(atIndex + 1);
	const nextSpace = rest.search(/\s/);
	const end = nextSpace === -1 ? text.length : atIndex + 1 + nextSpace;
	if (cursor > end) return null;

	return {
		start: atIndex,
		end,
		query: afterAt,
	};
}

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
	const containerRef = useRef<HTMLDivElement>(null);

	const [mcpTools, setMcpTools] = useState<McpToolItem[]>([]);
	const [mcpLoading, setMcpLoading] = useState(false);
	const [mcpError, setMcpError] = useState<string | null>(null);

	const [mentionState, setMentionState] = useState<MentionState | null>(null);
	const [toolPickerOpen, setToolPickerOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [cursorPos, setCursorPos] = useState(0);

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

	useEffect(() => {
		let cancelled = false;
		const loadMcpTools = async () => {
			setMcpLoading(true);
			setMcpError(null);
			try {
				const status = await apiClient.getMcpStatus();
				if (cancelled) return;
				const tools: McpToolItem[] = [];
				const seen = new Set<string>();
				for (const server of status.servers ?? []) {
					if (!server.connected) continue;
					if (!Array.isArray(server.tools)) continue;
					for (const tool of server.tools) {
						if (!tool?.name) continue;
						const id = buildMcpToolName(server.name, tool.name);
						if (seen.has(id)) continue;
						seen.add(id);
						tools.push({
							id,
							server: server.name,
							tool: tool.name,
							label: `${server.name}/${tool.name}`,
							description: tool.description,
						});
					}
				}
				setMcpTools(tools);
			} catch (err) {
				if (cancelled) return;
				setMcpError(
					err instanceof Error ? err.message : "Failed to load MCP tools",
				);
			} finally {
				if (!cancelled) {
					setMcpLoading(false);
				}
			}
		};

		loadMcpTools();

		return () => {
			cancelled = true;
		};
	}, []);

	const handleSubmit = () => {
		if (!value.trim() || disabled) return;
		onSend(value);
		setValue("");
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
		setToolPickerOpen(false);
		setMentionState(null);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (isPickerOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((prev) =>
					filteredTools.length === 0
						? 0
						: Math.min(prev + 1, filteredTools.length - 1),
				);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((prev) =>
					filteredTools.length === 0 ? 0 : Math.max(prev - 1, 0),
				);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const selected = filteredTools[activeIndex];
				if (selected) {
					handleSelectTool(selected);
				} else {
					closePicker();
				}
				return;
			}
			if (e.key === "Tab") {
				const selected = filteredTools[activeIndex];
				if (selected) {
					e.preventDefault();
					handleSelectTool(selected);
					return;
				}
			}
			if (e.key === "Escape") {
				e.preventDefault();
				closePicker();
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	const canSend = value.trim().length > 0 && !disabled;
	const isPickerOpen = toolPickerOpen || mentionState !== null;

	const filteredTools = useMemo(() => {
		if (!isPickerOpen) return [];
		const query = mentionState?.query.trim().toLowerCase() ?? "";
		if (!query) return mcpTools;
		return mcpTools.filter((tool) => {
			const haystack =
				`${tool.label} ${tool.id} ${tool.description ?? ""}`.toLowerCase();
			return haystack.includes(query);
		});
	}, [isPickerOpen, mentionState, mcpTools]);

	useEffect(() => {
		if (!isPickerOpen) {
			setActiveIndex(0);
			return;
		}
		setActiveIndex((prev) =>
			filteredTools.length === 0 ? 0 : Math.min(prev, filteredTools.length - 1),
		);
	}, [isPickerOpen, filteredTools.length]);

	useEffect(() => {
		if (!isPickerOpen) return;
		const handleOutsideClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target || !containerRef.current) return;
			if (!containerRef.current.contains(target)) {
				closePicker();
			}
		};
		document.addEventListener("mousedown", handleOutsideClick);
		return () => {
			document.removeEventListener("mousedown", handleOutsideClick);
		};
	}, [isPickerOpen]);

	const closePicker = useCallback(() => {
		setToolPickerOpen(false);
		setMentionState(null);
	}, []);

	const updateMentionState = useCallback((text: string, cursor: number) => {
		const nextMention = findMention(text, cursor);
		setMentionState(nextMention);
		if (nextMention) {
			setToolPickerOpen(false);
		}
	}, []);

	const insertAtCursor = useCallback(
		(text: string, range: { start: number; end: number }) => {
			const before = value.slice(0, range.start);
			const after = value.slice(range.end);
			const nextValue = `${before}${text}${after}`;
			setValue(nextValue);
			const nextCursor = before.length + text.length;
			setCursorPos(nextCursor);
			requestAnimationFrame(() => {
				const textarea = textareaRef.current;
				if (!textarea) return;
				textarea.focus();
				textarea.setSelectionRange(nextCursor, nextCursor);
			});
		},
		[value],
	);

	const handleSelectTool = useCallback(
		(tool: McpToolItem) => {
			const range = mentionState
				? { start: mentionState.start, end: mentionState.end }
				: { start: cursorPos, end: cursorPos };
			insertAtCursor(`@${tool.id} `, range);
			closePicker();
		},
		[mentionState, cursorPos, insertAtCursor, closePicker],
	);

	const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const nextValue = event.target.value;
		const nextCursor = event.target.selectionStart ?? nextValue.length;
		setValue(nextValue);
		setCursorPos(nextCursor);
		updateMentionState(nextValue, nextCursor);
	};

	const syncCursor = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
		const target = event.currentTarget;
		const nextCursor = target.selectionStart ?? target.value.length;
		setCursorPos(nextCursor);
		updateMentionState(target.value, nextCursor);
	};

	return (
		<div className="space-y-3" ref={containerRef}>
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
					{isPickerOpen && (
						<div className="absolute left-0 right-0 bottom-full mb-3 z-50">
							<div
								className="rounded-2xl border border-line-subtle/60 bg-bg-elevated/95 backdrop-blur
									shadow-[0_16px_40px_-20px_rgba(0,0,0,0.6)] overflow-hidden"
							>
								<div className="flex items-center justify-between px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-text-muted border-b border-line-subtle/60">
									<span>MCP tools</span>
									<span className="font-mono text-[10px] text-text-tertiary">
										{mcpTools.length} tools
									</span>
								</div>
								<div className="max-h-64 overflow-y-auto">
									{mcpLoading && (
										<div className="px-4 py-3 text-xs text-text-muted">
											Loading MCP tools...
										</div>
									)}
									{!mcpLoading && mcpError && (
										<div className="px-4 py-3 text-xs text-rose-300">
											{mcpError}
										</div>
									)}
									{!mcpLoading && !mcpError && filteredTools.length === 0 && (
										<div className="px-4 py-4 text-xs text-text-muted">
											No MCP tools available. Configure servers in
											<code className="ml-1 font-mono text-[11px] text-text-secondary">
												.composer/mcp.json
											</code>
											.
										</div>
									)}
									{!mcpLoading &&
										!mcpError &&
										filteredTools.map((tool, index) => (
											<button
												type="button"
												key={tool.id}
												onMouseDown={(event) => event.preventDefault()}
												onClick={() => handleSelectTool(tool)}
												className={`w-full text-left px-4 py-3 transition-colors ${
													index === activeIndex
														? "bg-accent/10"
														: "hover:bg-bg-tertiary/60"
												}`}
											>
												<div className="flex items-center justify-between gap-3">
													<div className="flex flex-col gap-1">
														<span className="text-sm text-text-primary font-medium">
															{tool.label}
														</span>
														<span className="font-mono text-[11px] text-text-tertiary">
															@{tool.id}
														</span>
													</div>
													{tool.description && (
														<span className="text-[11px] text-text-muted line-clamp-2">
															{tool.description}
														</span>
													)}
												</div>
											</button>
										))}
								</div>
							</div>
						</div>
					)}
					{/* Textarea */}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onClick={syncCursor}
						onKeyUp={syncCursor}
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

						{/* MCP tools button */}
						<button
							type="button"
							onClick={() => setToolPickerOpen((open) => !open)}
							disabled={disabled}
							className="p-2.5 rounded-xl text-text-muted hover:text-text-secondary hover:bg-bg-elevated/50
								transition-all duration-200 disabled:opacity-40"
							title={
								mcpLoading
									? "Loading MCP tools"
									: mcpError
										? "MCP tools unavailable"
										: mcpTools.length > 0
											? "Insert MCP tool"
											: "No MCP tools available"
							}
						>
							<svg
								aria-hidden="true"
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-4.6 4.6 2.8 2.8 4.6-4.6a4 4 0 0 0 5.4-5.4l3.1-3.1-2.8-2.8-3.1 3.1z" />
								<path d="M9.5 8.5l6 6" />
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
					{mcpTools.length > 0 && (
						<>
							<span className="text-text-muted/30 mx-1.5">|</span>
							<kbd className="px-1.5 py-0.5 bg-bg-tertiary/30 rounded-md text-text-tertiary font-mono text-[9px] border border-line-subtle/50">
								@
							</kbd>
							<span className="uppercase tracking-wider">tools</span>
						</>
					)}
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
