/**
 * ToolCall Component
 *
 * Displays a tool/function call execution.
 */

import { useState } from "react";
import { CodeBlock } from "../common";

export interface ToolCallProps {
	name: string;
	displayName?: string;
	summaryLabel?: string;
	args?: Record<string, unknown>;
	status?: "pending" | "running" | "success" | "error";
	result?: string;
}

export function ToolCall({
	name,
	displayName,
	summaryLabel,
	args,
	status = "success",
	result,
}: ToolCallProps) {
	const [expanded, setExpanded] = useState(false);

	const statusColors = {
		pending: "bg-warning/10 text-warning",
		running: "bg-accent/15 text-accent",
		success: "bg-success/10 text-success",
		error: "bg-error/10 text-error",
	};

	const statusIcons = {
		pending: (
			<svg
				aria-hidden="true"
				className="w-3.5 h-3.5"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
		),
		running: (
			<svg
				aria-hidden="true"
				className="w-3.5 h-3.5 animate-spin"
				fill="none"
				viewBox="0 0 24 24"
			>
				<circle
					className="opacity-25"
					cx="12"
					cy="12"
					r="10"
					stroke="currentColor"
					strokeWidth="4"
				/>
				<path
					className="opacity-75"
					fill="currentColor"
					d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
				/>
			</svg>
		),
		success: (
			<svg
				aria-hidden="true"
				className="w-3.5 h-3.5"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M5 13l4 4L19 7"
				/>
			</svg>
		),
		error: (
			<svg
				aria-hidden="true"
				className="w-3.5 h-3.5"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M6 18L18 6M6 6l12 12"
				/>
			</svg>
		),
	};

	// Get a readable tool name
	const getToolLabel = (name: string): string => {
		const labels: Record<string, string> = {
			read: "Read File",
			write: "Write File",
			edit: "Edit File",
			bash: "Run Command",
			search: "Search",
			list: "List Directory",
			diff: "View Diff",
		};
		return labels[name] || name;
	};

	return (
		<div className="tool-card animate-slide-up">
			{/* Header */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="tool-card-header w-full hover:bg-bg-elevated/50 transition-colors text-left"
			>
				{/* Status indicator */}
				<span
					className={`flex items-center justify-center w-6 h-6 rounded-lg ${statusColors[status]}`}
				>
					{statusIcons[status]}
				</span>

				{/* Tool name */}
				<span className="flex-1 text-sm font-medium text-text-primary">
					{summaryLabel || displayName || getToolLabel(name)}
				</span>

				{/* Tool ID */}
				<span className="text-[11px] font-mono text-text-muted px-2 py-0.5 rounded-md bg-bg-secondary">
					{name}
				</span>

				{/* Expand icon */}
				<svg
					aria-hidden="true"
					className={`w-4 h-4 text-text-tertiary transition-transform duration-200 ${
						expanded ? "rotate-180" : ""
					}`}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth="2"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M19 9l-7 7-7-7"
					/>
				</svg>
			</button>

			{/* Expanded content */}
			{expanded && (
				<div className="border-t border-line-subtle animate-fade-in">
					{/* Arguments */}
					{args && Object.keys(args).length > 0 && (
						<div className="tool-card-content border-b border-line-subtle">
							<div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-3">
								Arguments
							</div>
							<CodeBlock code={JSON.stringify(args, null, 2)} language="json" />
						</div>
					)}

					{/* Result */}
					{result && (
						<div className="tool-card-content">
							<div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-3">
								Result
							</div>
							<div className="text-[13px] text-text-secondary whitespace-pre-wrap font-mono bg-bg-tertiary rounded-xl p-4 max-h-60 overflow-auto border border-line-subtle">
								{result.length > 1000
									? `${result.substring(0, 1000)}...`
									: result}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
