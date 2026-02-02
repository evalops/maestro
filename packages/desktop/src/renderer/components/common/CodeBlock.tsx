/**
 * CodeBlock Component
 *
 * Syntax-highlighted code block with copy button.
 */

import hljs from "highlight.js";
import { useCallback, useEffect, useState } from "react";
import "highlight.js/styles/github-dark.css";

export interface CodeBlockProps {
	code: string;
	language?: string;
	filename?: string;
	showLineNumbers?: boolean;
}

export function CodeBlock({
	code,
	language,
	filename,
	showLineNumbers = false,
}: CodeBlockProps) {
	const [copied, setCopied] = useState(false);
	const [highlightedCode, setHighlightedCode] = useState<string>("");

	useEffect(() => {
		if (language && hljs.getLanguage(language)) {
			try {
				const result = hljs.highlight(code, { language });
				setHighlightedCode(result.value);
			} catch {
				setHighlightedCode(code);
			}
		} else {
			// Auto-detect language
			try {
				const result = hljs.highlightAuto(code);
				setHighlightedCode(result.value);
			} catch {
				setHighlightedCode(code);
			}
		}
	}, [code, language]);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback to electron clipboard if available
			if (window.electron?.writeClipboard) {
				window.electron.writeClipboard(code);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		}
	}, [code]);

	const lines = code.split("\n");

	return (
		<div className="group relative rounded-xl overflow-hidden bg-bg-secondary border border-line-subtle">
			{/* Header */}
			{(filename || language) && (
				<div className="flex items-center justify-between px-4 py-2.5 bg-bg-tertiary/50 border-b border-line-subtle">
					<div className="flex items-center gap-3">
						{/* Language/file icon */}
						<div className="w-5 h-5 rounded-md bg-bg-elevated flex items-center justify-center">
							<svg
								aria-hidden="true"
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								className="text-text-tertiary"
							>
								<polyline points="16 18 22 12 16 6" />
								<polyline points="8 6 2 12 8 18" />
							</svg>
						</div>
						{filename && (
							<span className="text-xs font-medium text-text-secondary font-mono">
								{filename}
							</span>
						)}
						{language && !filename && (
							<span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">
								{language}
							</span>
						)}
					</div>
					<button
						type="button"
						onClick={handleCopy}
						className="opacity-0 group-hover:opacity-100 transition-all duration-200 px-2.5 py-1 text-[11px] font-medium text-text-tertiary hover:text-text-primary rounded-lg hover:bg-bg-elevated"
					>
						{copied ? (
							<span className="flex items-center gap-1.5 text-success">
								<svg
									aria-hidden="true"
									className="w-3.5 h-3.5"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									strokeWidth="2"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										d="M5 13l4 4L19 7"
									/>
								</svg>
								Copied
							</span>
						) : (
							<span className="flex items-center gap-1.5">
								<svg
									aria-hidden="true"
									className="w-3.5 h-3.5"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									strokeWidth="2"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
									/>
								</svg>
								Copy
							</span>
						)}
					</button>
				</div>
			)}

			{/* Code Content */}
			<div className="overflow-x-auto">
				<pre className="p-4">
					{showLineNumbers ? (
						<code className="code-block flex">
							<span className="select-none pr-4 text-text-muted/50 border-r border-line-subtle mr-4 text-right min-w-[2.5rem]">
								{lines.map((_, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: Lines are render-stable
									<span key={i} className="block">
										{i + 1}
									</span>
								))}
							</span>
							<span
								className="flex-1"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: Syntax highlighting requires innerHTML
								dangerouslySetInnerHTML={{ __html: highlightedCode }}
							/>
						</code>
					) : (
						<code
							className="code-block"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Syntax highlighting requires innerHTML
							dangerouslySetInnerHTML={{ __html: highlightedCode }}
						/>
					)}
				</pre>
			</div>

			{/* Floating copy button when no header */}
			{!filename && !language && (
				<button
					type="button"
					onClick={handleCopy}
					className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-all duration-200 p-2 text-text-tertiary hover:text-text-primary rounded-lg bg-bg-tertiary/90 hover:bg-bg-elevated backdrop-blur-sm border border-line-subtle"
				>
					{copied ? (
						<svg
							aria-hidden="true"
							className="w-4 h-4 text-success"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth="2"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M5 13l4 4L19 7"
							/>
						</svg>
					) : (
						<svg
							aria-hidden="true"
							className="w-4 h-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth="2"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
							/>
						</svg>
					)}
				</button>
			)}
		</div>
	);
}
