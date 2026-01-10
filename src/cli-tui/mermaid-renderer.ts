import chalk from "chalk";

const CONNECTORS = [
	"<-.->",
	"<-->",
	"<--",
	"<==>",
	"<=>",
	"-.->",
	"-->",
	"---",
	"==>",
	"--x",
	"--o",
	"-x->",
	"-o->",
];

const MIN_BOX_WIDTH = 6;
const MAX_BOX_WIDTH = 28;
const BOX_HEIGHT = 3;
const H_SPACING = 4;
const V_SPACING = 2;
const MAX_LABEL = 36;

type Orientation = "TD" | "TB" | "BT" | "LR" | "RL";

interface MermaidNode {
	id: string;
	label: string;
	order: number;
}

interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
}

interface ParsedMermaid {
	orientation: Orientation;
	nodes: MermaidNode[];
	edges: MermaidEdge[];
}

const diagramCache = new Map<string, string[] | null>();

export function renderMermaidDiagram(
	source: string,
	width: number,
): string[] | null {
	const cacheKey = `${width}:${source}`;
	if (diagramCache.has(cacheKey)) {
		return diagramCache.get(cacheKey) ?? null;
	}
	const parsed = parseMermaid(source);
	if (!parsed) {
		diagramCache.set(cacheKey, null);
		return null;
	}
	const renderer = new MermaidAsciiRenderer(parsed, width);
	const lines = renderer.render();
	diagramCache.set(cacheKey, lines);
	return lines;
}

class MermaidAsciiRenderer {
	constructor(
		private readonly diagram: ParsedMermaid,
		private width: number,
	) {}

	render(): string[] | null {
		if (this.diagram.nodes.length === 0) {
			return null;
		}
		const layout = this.buildLayout();
		if (layout) {
			return layout;
		}
		return this.buildFallback();
	}

	private buildLayout(): string[] | null {
		const layerMap = assignLayers(this.diagram);
		if (!layerMap) {
			return null;
		}
		const layers = groupByLayer(this.diagram.nodes, layerMap);
		const maxLayerSize = Math.max(...layers.map((layer) => layer.length));
		const boxWidth = this.computeBoxWidth(maxLayerSize);
		if (!boxWidth) {
			return null;
		}
		const diagramWidth =
			maxLayerSize * boxWidth + Math.max(0, maxLayerSize - 1) * H_SPACING;
		const verticalLayerCount = layers.length;
		const canvasHeight =
			verticalLayerCount * BOX_HEIGHT +
			Math.max(0, verticalLayerCount - 1) * V_SPACING;
		const canvas = Array.from({ length: canvasHeight }, () =>
			Array.from({ length: diagramWidth }, () => " "),
		);
		const nodePositions = new Map<string, { x: number; y: number }>();
		layers.forEach((layer, layerIndex) => {
			const rowY = layerIndex * (BOX_HEIGHT + V_SPACING);
			layer.forEach((node, nodeIndex) => {
				const boxX = nodeIndex * (boxWidth + H_SPACING);
				this.drawBox(canvas, boxX, rowY, boxWidth, node.label);
				nodePositions.set(node.id, { x: boxX, y: rowY });
			});
		});
		const edgeWarnings = this.drawEdges(canvas, nodePositions, boxWidth);
		const title = chalk.hex("#a855f7")(
			`╭─ mermaid graph (${this.diagram.orientation}) ─╮`,
		);
		const footer = chalk.hex("#a855f7")("╰──────────────────────────────╯");
		const warningLines = edgeWarnings.length
			? edgeWarnings.map((warning) => chalk.dim(`[!] ${warning}`))
			: [];
		return [
			title,
			...canvas.map((row) => row.join("")),
			footer,
			...warningLines,
		];
	}

	private computeBoxWidth(maxLayerSize: number): number | null {
		const longestLabel = Math.min(
			MAX_LABEL,
			Math.max(...this.diagram.nodes.map((node) => node.label.length)),
		);
		const naturalWidth = Math.max(MIN_BOX_WIDTH, longestLabel + 2);
		const maxAllowedWidth = Math.min(MAX_BOX_WIDTH, this.width);
		const spacingWidth = Math.max(0, maxLayerSize - 1) * H_SPACING;
		const available = maxAllowedWidth - spacingWidth;
		const perBox = Math.floor(available / maxLayerSize);
		if (perBox < MIN_BOX_WIDTH) {
			return null;
		}
		return Math.min(naturalWidth, perBox);
	}

	private drawBox(
		canvas: string[][],
		x: number,
		y: number,
		boxWidth: number,
		label: string,
	): void {
		const innerWidth = boxWidth - 2;
		const truncated = truncateLabel(label, innerWidth);
		const paddedLabel = centerText(truncated, innerWidth);
		const top = `┌${"─".repeat(innerWidth)}┐`;
		const mid = `│${paddedLabel}│`;
		const bottom = `└${"─".repeat(innerWidth)}┘`;
		[top, mid, bottom].forEach((line, offset) => {
			const row = canvas[y + offset];
			if (!row) {
				return;
			}
			for (let i = 0; i < boxWidth; i++) {
				row[x + i] = line[i]!;
			}
		});
	}

	private drawEdges(
		canvas: string[][],
		nodePositions: Map<string, { x: number; y: number }>,
		boxWidth: number,
	): string[] {
		const warnings: string[] = [];
		for (const edge of this.diagram.edges) {
			const from = nodePositions.get(edge.from);
			const to = nodePositions.get(edge.to);
			if (!from || !to) {
				warnings.push(`Skipped edge ${edge.from} -> ${edge.to} (node missing)`);
				continue;
			}
			if (to.y <= from.y) {
				warnings.push(
					`Skipped edge ${edge.from} -> ${edge.to} (non-forward edge not drawn)`,
				);
				continue;
			}
			const startX = from.x + Math.floor(boxWidth / 2);
			const startY = from.y + BOX_HEIGHT;
			const endX = to.x + Math.floor(boxWidth / 2);
			const endY = to.y - 1;
			const midY = Math.floor((startY + endY) / 2);
			for (let y = startY; y < midY; y++) {
				setChar(canvas, startX, y, "│");
			}
			const turnChar = startX <= endX ? "└" : "┘";
			setChar(canvas, startX, midY, turnChar);
			const step = startX <= endX ? 1 : -1;
			for (let x = startX + step; step === 1 ? x < endX : x > endX; x += step) {
				setChar(canvas, x, midY, "─");
			}
			const corner = startX <= endX ? "┐" : "┌";
			setChar(canvas, endX, midY, corner);
			for (let y = midY + 1; y < endY; y++) {
				setChar(canvas, endX, y, "│");
			}
			const arrowHead = "▼";
			setChar(canvas, endX, endY, arrowHead);
			if (edge.label) {
				this.writeLabel(canvas, edge.label, startX, endX, midY - 1);
			}
		}
		return warnings;
	}

	private writeLabel(
		canvas: string[][],
		label: string,
		startX: number,
		endX: number,
		y: number,
	): void {
		if (y < 0) {
			return;
		}
		const minX = Math.min(startX, endX);
		const maxX = Math.max(startX, endX);
		if (maxX - minX < 4) {
			return;
		}
		const text = truncateLabel(label, maxX - minX - 2);
		const offsetStart = minX + 1;
		for (let i = 0; i < text.length; i++) {
			setChar(canvas, offsetStart + i, y, text[i]!);
		}
	}

	private buildFallback(): string[] {
		const lines = [
			chalk.bold("Mermaid diagram"),
			chalk.dim("(using textual summary)"),
			"Nodes:",
			...this.diagram.nodes.map((node) => `  • ${node.id} – ${node.label}`),
			"Edges:",
			...this.diagram.edges.map((edge) => {
				const label = edge.label ? ` [${edge.label}]` : "";
				return `  • ${edge.from} ──▶ ${edge.to}${label}`;
			}),
		];
		return lines;
	}
}

function assignLayers(diagram: ParsedMermaid): Map<string, number> | null {
	const indegree = new Map<string, number>();
	for (const node of diagram.nodes) {
		indegree.set(node.id, 0);
	}
	for (const edge of diagram.edges) {
		if (edge.from === edge.to) {
			continue;
		}
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	}
	const layerMap = new Map<string, number>();
	const queue: MermaidNode[] = [];
	for (const node of diagram.nodes) {
		if ((indegree.get(node.id) ?? 0) === 0) {
			queue.push(node);
			if (!layerMap.has(node.id)) {
				layerMap.set(node.id, 0);
			}
		}
	}
	let cursor = 0;
	while (cursor < queue.length) {
		const node = queue[cursor]!;
		cursor += 1;
		const currentLayer = layerMap.get(node.id) ?? 0;
		for (const edge of diagram.edges) {
			if (edge.from !== node.id) {
				continue;
			}
			const nextLayer = Math.max(currentLayer + 1, layerMap.get(edge.to) ?? 0);
			layerMap.set(edge.to, nextLayer);
			const nextIndegree = (indegree.get(edge.to) ?? 1) - 1;
			indegree.set(edge.to, nextIndegree);
			if (nextIndegree === 0) {
				const nextNode = diagram.nodes.find((item) => item.id === edge.to);
				if (nextNode) {
					queue.push(nextNode);
				}
			}
		}
	}
	if (layerMap.size !== diagram.nodes.length) {
		let maxLayerValue = -1;
		for (const value of layerMap.values()) {
			maxLayerValue = Math.max(maxLayerValue, value);
		}
		let nextLayer = Math.max(0, maxLayerValue + 1);
		for (const node of diagram.nodes) {
			if (!layerMap.has(node.id)) {
				layerMap.set(node.id, nextLayer);
				nextLayer += 1;
			}
		}
	}
	return layerMap;
}

function groupByLayer(
	nodes: MermaidNode[],
	layerMap: Map<string, number>,
): MermaidNode[][] {
	const layers: MermaidNode[][] = [];
	for (const node of nodes) {
		const layer = layerMap.get(node.id) ?? 0;
		if (!layers[layer]) {
			layers[layer] = [];
		}
		layers[layer].push(node);
	}
	return layers.map((layer) => layer.sort((a, b) => a.order - b.order));
}

function parseMermaid(source: string): ParsedMermaid | null {
	const cleanedLines = source
		.split(/\r?\n/)
		.map((line) => line.replace(/%%.*$/, "").trim())
		.filter((line) => line.length > 0);
	if (cleanedLines.length === 0) {
		return null;
	}
	let orientation: Orientation = "TD";
	const nodes = new Map<string, MermaidNode>();
	const edges: MermaidEdge[] = [];
	let order = 0;
	for (const line of cleanedLines) {
		if (line.toLowerCase().startsWith("graph")) {
			orientation = parseOrientation(line) ?? orientation;
			continue;
		}
		if (/^(subgraph|end|classDef|style|linkStyle|click)/i.test(line)) {
			continue;
		}
		const connector = findConnector(line);
		if (connector) {
			const { left, right, label, reversed } = splitEdge(line, connector);
			const startToken = parseNodeToken(left);
			const endToken = parseNodeToken(right);
			if (!startToken || !endToken) {
				continue;
			}
			const from = reversed ? endToken.id : startToken.id;
			const to = reversed ? startToken.id : endToken.id;
			ensureNode(
				nodes,
				from,
				reversed ? endToken.label : startToken.label,
				order++,
			);
			ensureNode(
				nodes,
				to,
				reversed ? startToken.label : endToken.label,
				order++,
			);
			edges.push({ from, to, label });
			continue;
		}
		const token = parseNodeToken(line);
		if (token) {
			ensureNode(nodes, token.id, token.label, order++);
		}
	}
	if (!nodes.size && !edges.length) {
		return null;
	}
	// Ensure nodes referenced by edges exist
	for (const edge of edges) {
		ensureNode(nodes, edge.from, edge.from, order++);
		ensureNode(nodes, edge.to, edge.to, order++);
	}
	return {
		orientation,
		nodes: Array.from(nodes.values()),
		edges,
	};
}

function ensureNode(
	nodes: Map<string, MermaidNode>,
	id: string,
	label: string,
	order: number,
): void {
	if (!nodes.has(id)) {
		nodes.set(id, { id, label, order });
	}
}

function parseOrientation(line: string): Orientation | null {
	const match = line.match(/graph\s+(TD|TB|BT|LR|RL)/i);
	if (match?.[1]) {
		return match[1].toUpperCase() as Orientation;
	}
	return null;
}

function findConnector(line: string): string | null {
	for (const token of CONNECTORS) {
		const index = line.indexOf(token);
		if (index >= 0) {
			return token;
		}
	}
	return null;
}

function splitEdge(
	line: string,
	connector: string,
): {
	left: string;
	right: string;
	label?: string;
	reversed: boolean;
} {
	const parts = line.split(connector);
	const left = parts[0]?.trim() ?? "";
	let right = parts[1]?.trim() ?? "";
	let label: string | undefined;
	if (right.startsWith("|")) {
		const closing = right.indexOf("|", 1);
		if (closing > 1) {
			label = right.slice(1, closing).trim();
			right = right.slice(closing + 1).trim();
		}
	}
	const reversed = connector.startsWith("<");
	return { left, right, label, reversed };
}

function parseNodeToken(token: string): { id: string; label: string } | null {
	const idMatch = token.match(/^[A-Za-z0-9_:-]+/);
	if (!idMatch) {
		return null;
	}
	const id = idMatch[0];
	const remainder = token.slice(id.length).trim();
	if (!remainder) {
		return { id, label: id };
	}
	const labelMatch = remainder.match(
		/^(?:\[(.+?)\]|\((.+?)\)|\{(.+?)\}|\(\((.+?)\)\))/,
	);
	if (labelMatch) {
		const label = labelMatch.slice(1).find((value) => value !== undefined);
		return { id, label: (label ?? id).trim() };
	}
	return { id, label: id };
}

function truncateLabel(label: string, width: number): string {
	if (label.length <= width) {
		return label.padEnd(width, " ");
	}
	if (width <= 1) {
		return label.slice(0, width);
	}
	return `${label.slice(0, width - 1)}…`;
}

function centerText(text: string, width: number): string {
	if (text.length >= width) {
		return text;
	}
	const totalPadding = width - text.length;
	const left = Math.floor(totalPadding / 2);
	const right = totalPadding - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function setChar(canvas: string[][], x: number, y: number, char: string): void {
	const row = canvas[y];
	if (!row || !row[x]) {
		return;
	}
	row[x] = char;
}
