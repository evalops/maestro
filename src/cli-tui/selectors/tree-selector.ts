import { Container, Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import type { AppMessage, TextContent } from "../../agent/types.js";
import type {
	SessionTreeEntry,
	SessionTreeNode,
} from "../../session/manager.js";
import { stripAnsiSequences } from "../utils/text-formatting.js";

interface FlatTreeNode {
	node: SessionTreeNode;
	depth: number;
}

function truncateLine(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (text.length <= maxWidth) return text;
	if (maxWidth <= 3) return text.slice(0, maxWidth);
	return `${text.slice(0, maxWidth - 3)}...`;
}

function normalizePreview(text: string): string {
	return stripAnsiSequences(text).replace(/\s+/g, " ").trim();
}

function extractTextFromContent(
	content: string | { type: string; text?: string }[],
): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter(
				(block) => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

function previewMessage(message: AppMessage): string {
	if (message.role === "user") {
		const text = normalizePreview(extractTextFromContent(message.content));
		return text ? `user: ${text}` : "user message";
	}
	if (message.role === "assistant") {
		const firstText = message.content.find(
			(block): block is TextContent => block.type === "text",
		);
		const text = normalizePreview(firstText?.text ?? "");
		return text ? `assistant: ${text}` : "assistant response";
	}
	if (message.role === "toolResult") {
		return `tool: ${message.toolName}`;
	}
	if (message.role === "hookMessage") {
		return `hook: ${message.customType}`;
	}
	if (message.role === "branchSummary") {
		return "branch summary";
	}
	if (message.role === "compactionSummary") {
		return "compaction summary";
	}
	return "message";
}

function previewEntry(entry: SessionTreeEntry, label?: string): string {
	const labelText = label ? `[${label}] ` : "";
	if (entry.type === "message") {
		return `${labelText}${previewMessage(entry.message)}`;
	}
	if (entry.type === "custom_message") {
		const text = normalizePreview(extractTextFromContent(entry.content));
		const suffix = text ? ` ${text}` : "";
		return `${labelText}hook: ${entry.customType}${suffix}`;
	}
	if (entry.type === "compaction") {
		const text = normalizePreview(entry.summary);
		return `${labelText}compaction: ${text || "summary"}`;
	}
	if (entry.type === "branch_summary") {
		const text = normalizePreview(entry.summary);
		return `${labelText}branch summary: ${text || "summary"}`;
	}
	if (entry.type === "thinking_level_change") {
		return `${labelText}thinking: ${entry.thinkingLevel}`;
	}
	if (entry.type === "model_change") {
		return `${labelText}model: ${entry.model}`;
	}
	if (entry.type === "custom") {
		return `${labelText}custom: ${entry.customType}`;
	}
	if (entry.type === "label") {
		const text = entry.label ? `label: ${entry.label}` : "label cleared";
		return `${labelText}${text}`;
	}
	return `${labelText}entry`;
}

class TreeList extends Container {
	private flatNodes: FlatTreeNode[] = [];
	private selectedIndex = 0;
	private maxVisible = 12;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onLabelEdit?: (entryId: string, label?: string) => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
	) {
		super();
		this.maxVisible = Math.max(4, Math.min(20, maxVisibleLines - 8));
		this.flatNodes = this.flattenTree(tree, 0);

		const leafIndex = this.flatNodes.findIndex(
			(node) => node.node.entry.id === currentLeafId,
		);
		if (leafIndex !== -1) {
			this.selectedIndex = leafIndex;
		} else {
			this.selectedIndex = Math.max(0, this.flatNodes.length - 1);
		}
	}

	private flattenTree(nodes: SessionTreeNode[], depth: number): FlatTreeNode[] {
		const result: FlatTreeNode[] = [];
		for (const node of nodes) {
			result.push({ node, depth });
			if (node.children.length > 0) {
				result.push(...this.flattenTree(node.children, depth + 1));
			}
		}
		return result;
	}

	updateLabel(entryId: string, label?: string): void {
		for (const node of this.flatNodes) {
			if (node.node.entry.id === entryId) {
				node.node.label = label;
				break;
			}
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.flatNodes.length === 0) {
			lines.push(chalk.dim("  No entries found"));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.flatNodes.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + this.maxVisible,
			this.flatNodes.length,
		);

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.flatNodes[i];
			const isSelected = i === this.selectedIndex;
			const indent = "  ".repeat(flatNode.depth);
			const prefix = `${indent}- `;
			const text = previewEntry(flatNode.node.entry, flatNode.node.label);
			const line = truncateLine(prefix + text, width - 2);
			const cursor = isSelected ? chalk.cyan("› ") : "  ";
			lines.push(cursor + (isSelected ? chalk.bold(line) : chalk.dim(line)));
		}

		if (startIndex > 0 || endIndex < this.flatNodes.length) {
			lines.push(
				chalk.dim(`  (${this.selectedIndex + 1}/${this.flatNodes.length})`),
			);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(
				this.flatNodes.length - 1,
				this.selectedIndex + 1,
			);
			return;
		}
		if (keyData === "\r") {
			const selected = this.flatNodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
			return;
		}
		if (keyData === "l") {
			const selected = this.flatNodes[this.selectedIndex];
			if (
				selected &&
				this.onLabelEdit &&
				selected.node.entry.type !== "label"
			) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
			return;
		}
		if (keyData === "\x1b" || keyData === "\x03") {
			this.onCancel?.();
		}
	}
}

export class TreeSelectorComponent extends Container {
	private treeList: TreeList;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		options: {
			onSelect: (entryId: string) => void;
			onCancel: () => void;
			onLabelEdit?: (entryId: string, label?: string) => void;
		},
	) {
		super();

		this.addChild(new Spacer(1));
		this.addChild(new Text(chalk.bold("Session Tree"), 1, 0));
		this.addChild(
			new Text(chalk.dim("Select a point in the conversation tree"), 1, 0),
		);
		this.addChild(new Spacer(1));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines);
		this.treeList.onSelect = options.onSelect;
		this.treeList.onCancel = options.onCancel;
		this.treeList.onLabelEdit = options.onLabelEdit;
		this.addChild(this.treeList);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				chalk.dim("↑/↓: Navigate  Enter: Select  L: Label  Esc: Cancel"),
				1,
				0,
			),
		);
	}

	getTreeList(): TreeList {
		return this.treeList;
	}

	updateLabel(entryId: string, label?: string): void {
		this.treeList.updateLabel(entryId, label);
	}
}
