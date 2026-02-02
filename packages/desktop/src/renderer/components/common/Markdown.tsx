/**
 * Markdown Component
 *
 * Renders markdown content with syntax highlighting.
 */

import { type Tokens, marked } from "marked";
import { useMemo } from "react";
import { CodeBlock } from "./CodeBlock";

export interface MarkdownProps {
	content: string;
	className?: string;
}

// Configure marked options
marked.setOptions({
	gfm: true,
	breaks: true,
	async: false,
});

export function Markdown({ content, className = "" }: MarkdownProps) {
	const rendered = useMemo(() => {
		// Parse the markdown
		const tokens = marked.lexer(content);
		const elements: React.ReactNode[] = [];
		let key = 0;

		const renderToken = (token: marked.Token): React.ReactNode => {
			const tokenKey = `token-${key++}-${token.type}`;
			switch (token.type) {
				case "code":
					return (
						<CodeBlock
							key={tokenKey}
							code={token.text}
							language={token.lang || undefined}
						/>
					);

				case "heading": {
					const HeadingTag = `h${token.depth}` as keyof JSX.IntrinsicElements;
					return (
						<HeadingTag
							key={tokenKey}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
							dangerouslySetInnerHTML={{
								__html: marked.parseInline(token.text) as string,
							}}
						/>
					);
				}

				case "paragraph":
					return (
						<p
							key={tokenKey}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
							dangerouslySetInnerHTML={{
								__html: marked.parseInline(token.text) as string,
							}}
						/>
					);

				case "list": {
					const ListTag = token.ordered ? "ol" : "ul";
					return (
						<ListTag key={tokenKey}>
							{token.items.map((item: Tokens.ListItem, i: number) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: List items are render-stable from markdown tokens
									key={`${tokenKey}-item-${i}`}
									// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
									dangerouslySetInnerHTML={{
										__html: marked.parseInline(item.text) as string,
									}}
								/>
							))}
						</ListTag>
					);
				}

				case "blockquote":
					return (
						<blockquote
							key={tokenKey}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
							dangerouslySetInnerHTML={{
								__html: marked.parse(token.text) as string,
							}}
						/>
					);

				case "hr":
					return <hr key={tokenKey} />;

				case "table":
					return (
						<table key={tokenKey}>
							<thead>
								<tr>
									{token.header.map((cell: Tokens.TableCell, i: number) => (
										<th
											// biome-ignore lint/suspicious/noArrayIndexKey: Table cells are render-stable from markdown tokens
											key={`${tokenKey}-header-${i}`}
											// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
											dangerouslySetInnerHTML={{
												__html: marked.parseInline(cell.text) as string,
											}}
										/>
									))}
								</tr>
							</thead>
							<tbody>
								{token.rows.map((row: Tokens.TableCell[], i: number) => (
									<tr
										// biome-ignore lint/suspicious/noArrayIndexKey: Table rows are render-stable from markdown tokens
										key={`${tokenKey}-row-${i}`}
									>
										{row.map((cell: Tokens.TableCell, j: number) => (
											<td
												// biome-ignore lint/suspicious/noArrayIndexKey: Table cells are render-stable from markdown tokens
												key={`${tokenKey}-cell-${i}-${j}`}
												// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
												dangerouslySetInnerHTML={{
													__html: marked.parseInline(cell.text) as string,
												}}
											/>
										))}
									</tr>
								))}
							</tbody>
						</table>
					);

				case "space":
					return null;

				case "html":
					// Sanitize HTML - just render text content
					return (
						<div
							key={tokenKey}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
							dangerouslySetInnerHTML={{ __html: token.text }}
						/>
					);

				default:
					// For any other token types, render as paragraph
					if ("text" in token && typeof token.text === "string") {
						return (
							<p
								key={tokenKey}
								// biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown rendering requires innerHTML
								dangerouslySetInnerHTML={{
									__html: marked.parseInline(token.text) as string,
								}}
							/>
						);
					}
					return null;
			}
		};

		for (const token of tokens) {
			const element = renderToken(token);
			if (element) {
				elements.push(element);
			}
		}

		return elements;
	}, [content]);

	return <div className={`markdown-content ${className}`}>{rendered}</div>;
}
