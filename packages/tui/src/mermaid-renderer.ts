/**
 * @fileoverview Mermaid Diagram ASCII Renderer
 *
 * This module provides a complete ASCII/Unicode rendering pipeline for Mermaid
 * graph diagrams in terminal environments. It parses Mermaid syntax and produces
 * a visual representation using box-drawing characters.
 *
 * ## Architecture Overview
 *
 * The rendering pipeline consists of three main phases:
 *
 * 1. **Parsing Phase** (parseMermaid):
 *    - Tokenizes Mermaid syntax into nodes and edges
 *    - Handles various connector types (arrows, dashed lines, etc.)
 *    - Extracts labels and edge annotations
 *
 * 2. **Layout Phase** (assignLayers, groupByLayer):
 *    - Uses a modified topological sort to assign vertical layers
 *    - Implements Kahn's algorithm for DAG processing
 *    - Handles cycles gracefully by placing remaining nodes at the bottom
 *
 * 3. **Rendering Phase** (MermaidAsciiRenderer):
 *    - Allocates a 2D character canvas
 *    - Draws boxes with Unicode box-drawing characters
 *    - Routes edges between nodes using L-shaped connectors
 *
 * ## Coordinate System
 *
 * The canvas uses a standard screen coordinate system:
 * - Origin (0,0) is at the top-left
 * - X increases rightward (columns)
 * - Y increases downward (rows)
 *
 * ## Caching Strategy
 *
 * Results are cached using a composite key of width and source to avoid
 * redundant parsing and rendering. This is essential for smooth scrolling
 * in terminal UIs where diagrams may be re-rendered frequently.
 */
import chalk from "chalk";

/**
 * Mermaid edge connector tokens, ordered by specificity.
 *
 * The order matters because we use first-match semantics during parsing.
 * More specific/longer connectors must appear before shorter ones to prevent
 * partial matches (e.g., "<-.-> " must be checked before "-->").
 *
 * Connector types:
 * - Bidirectional: <-.->, <-->, <=>
 * - Reverse direction: <-- (arrow points left)
 * - Dashed: -.->
 * - Solid: -->, ---
 * - Thick: ==>, <=>
 * - Special endings: --x (cross), --o (circle)
 */
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

/**
 * Layout constants for the ASCII rendering.
 *
 * These values control the visual appearance and spacing of the diagram:
 *
 * MIN_BOX_WIDTH: Minimum width for a node box (ensures readability)
 * MAX_BOX_WIDTH: Maximum width to prevent overly wide boxes
 * BOX_HEIGHT: Fixed height of 3 lines (top border, label, bottom border)
 * H_SPACING: Horizontal gap between adjacent nodes in the same layer
 * V_SPACING: Vertical gap between layers (allows space for edge routing)
 * MAX_LABEL: Maximum label length before truncation with ellipsis
 */
const MIN_BOX_WIDTH = 6;
const MAX_BOX_WIDTH = 28;
const BOX_HEIGHT = 3;
const H_SPACING = 4;
const V_SPACING = 2;
const MAX_LABEL = 36;

/**
 * Mermaid graph orientation types.
 *
 * Currently the renderer primarily handles TD/TB (top-down) layouts.
 * Other orientations are parsed but may not render optimally:
 * - TD/TB: Top to Bottom (default, fully supported)
 * - BT: Bottom to Top
 * - LR: Left to Right
 * - RL: Right to Left
 */
type Orientation = "TD" | "TB" | "BT" | "LR" | "RL";

/**
 * Represents a node in the Mermaid graph.
 *
 * @property id - Unique identifier used for edge connections
 * @property label - Display text shown inside the node box
 * @property order - Parse order, used to maintain stable positioning
 */
interface MermaidNode {
	id: string;
	label: string;
	order: number;
}

/**
 * Represents a directed edge between two nodes.
 *
 * @property from - Source node ID
 * @property to - Target node ID
 * @property label - Optional edge annotation (displayed along the edge path)
 */
interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
}

/**
 * Complete parsed representation of a Mermaid diagram.
 *
 * This intermediate representation decouples parsing from rendering,
 * allowing the same parsed structure to be rendered at different widths.
 */
interface ParsedMermaid {
	orientation: Orientation;
	nodes: MermaidNode[];
	edges: MermaidEdge[];
}

/**
 * Global cache for rendered diagrams.
 *
 * Cache key format: `${width}:${source}`
 *
 * This cache is unbounded, which is acceptable because:
 * 1. In practice, only a few diagrams are active at any time
 * 2. Width changes are infrequent (usually only on terminal resize)
 * 3. The cache naturally clears on process restart
 *
 * For long-running processes with many unique diagrams, consider
 * implementing an LRU eviction policy.
 */
const diagramCache = new Map<string, string[] | null>();

/**
 * Main entry point for rendering Mermaid diagrams to ASCII art.
 *
 * This function handles caching and orchestrates the parsing and rendering
 * pipeline. It returns null for diagrams that cannot be rendered (invalid
 * syntax, unsupported features, or insufficient width).
 *
 * @param source - Raw Mermaid diagram source code
 * @param width - Available terminal width in characters
 * @returns Array of rendered lines, or null if rendering fails
 *
 * @example
 * ```typescript
 * const lines = renderMermaidDiagram(`
 *   graph TD
 *   A[Start] --> B[Process]
 *   B --> C[End]
 * `, 80);
 * if (lines) {
 *   lines.forEach(line => console.log(line));
 * }
 * ```
 */
export function renderMermaidDiagram(
	source: string,
	width: number,
): string[] | null {
	// Use composite cache key to handle width-dependent rendering
	const cacheKey = `${width}:${source}`;
	if (diagramCache.has(cacheKey)) {
		return diagramCache.get(cacheKey) ?? null;
	}

	// Parse the Mermaid source into an intermediate representation
	const parsed = parseMermaid(source);
	if (!parsed) {
		diagramCache.set(cacheKey, null);
		return null;
	}

	// Render the parsed diagram to ASCII lines
	const renderer = new MermaidAsciiRenderer(parsed, width);
	const lines = renderer.render();
	diagramCache.set(cacheKey, lines);
	return lines;
}

/**
 * ASCII renderer for Mermaid diagrams.
 *
 * This class implements the core rendering logic, transforming a parsed
 * Mermaid diagram into an array of ANSI-styled terminal lines.
 *
 * ## Rendering Strategy
 *
 * 1. **Layer Assignment**: Nodes are assigned to horizontal layers based on
 *    their dependency depth (distance from source nodes)
 *
 * 2. **Box Sizing**: Box width is calculated to fit all labels while
 *    respecting terminal width constraints
 *
 * 3. **Canvas Allocation**: A 2D character array is created with dimensions
 *    based on layer count and maximum layer width
 *
 * 4. **Box Drawing**: Each node is rendered as a Unicode box at its
 *    calculated position
 *
 * 5. **Edge Routing**: Edges are drawn using L-shaped paths with arrowheads
 *
 * ## Fallback Mode
 *
 * If the diagram cannot be rendered graphically (e.g., too wide, contains
 * cycles, or uses unsupported features), a textual fallback is provided
 * listing nodes and edges.
 */
class MermaidAsciiRenderer {
	constructor(
		private readonly diagram: ParsedMermaid,
		private width: number,
	) {}

	/**
	 * Renders the diagram, falling back to text mode if graphical
	 * rendering fails.
	 *
	 * @returns Array of styled terminal lines, or null if diagram is empty
	 */
	render(): string[] | null {
		if (this.diagram.nodes.length === 0) {
			return null;
		}
		// Attempt graphical layout first
		const layout = this.buildLayout();
		if (layout) {
			return layout;
		}
		// Fall back to textual summary for complex/unsupported diagrams
		return this.buildFallback();
	}

	/**
	 * Attempts to build a graphical ASCII layout of the diagram.
	 *
	 * This method orchestrates the full graphical rendering pipeline:
	 * 1. Assign nodes to vertical layers using topological sort
	 * 2. Calculate optimal box width for the terminal
	 * 3. Create a character canvas and render boxes
	 * 4. Draw connecting edges with arrowheads
	 *
	 * @returns Rendered lines if successful, null if layout is impossible
	 */
	private buildLayout(): string[] | null {
		// Phase 1: Assign each node to a vertical layer using topological sort
		// This ensures parent nodes appear above their children
		const layerMap = assignLayers(this.diagram);
		if (!layerMap) {
			return null;
		}

		// Phase 2: Group nodes by their assigned layer for row-by-row rendering
		const layers = groupByLayer(this.diagram.nodes, layerMap);
		const maxLayerSize = Math.max(...layers.map((layer) => layer.length));

		// Phase 3: Calculate box width that fits all labels within terminal width
		// Returns null if boxes cannot fit even at minimum width
		const boxWidth = this.computeBoxWidth(maxLayerSize);
		if (!boxWidth) {
			return null;
		}

		// Phase 4: Calculate canvas dimensions
		// Width: boxes + horizontal spacing between them
		// Height: box rows + vertical spacing for edge routing
		const diagramWidth =
			maxLayerSize * boxWidth + Math.max(0, maxLayerSize - 1) * H_SPACING;
		const verticalLayerCount = layers.length;
		const canvasHeight =
			verticalLayerCount * BOX_HEIGHT +
			Math.max(0, verticalLayerCount - 1) * V_SPACING;

		// Phase 5: Create the 2D character canvas initialized with spaces
		// Each cell holds a single character that will be assembled into output lines
		const canvas = Array.from({ length: canvasHeight }, () =>
			Array.from({ length: diagramWidth }, () => " "),
		);

		// Phase 6: Render boxes and track their positions for edge routing
		// nodePositions maps node ID -> top-left corner of its box
		const nodePositions = new Map<string, { x: number; y: number }>();
		layers.forEach((layer, layerIndex) => {
			// Calculate Y coordinate for this layer's row
			const rowY = layerIndex * (BOX_HEIGHT + V_SPACING);
			layer.forEach((node, nodeIndex) => {
				// Calculate X coordinate for this node's column
				const boxX = nodeIndex * (boxWidth + H_SPACING);
				this.drawBox(canvas, boxX, rowY, boxWidth, node.label);
				nodePositions.set(node.id, { x: boxX, y: rowY });
			});
		});

		// Phase 7: Draw edges connecting nodes with L-shaped paths
		// Collect warnings for edges that couldn't be drawn (missing nodes, cycles)
		const edgeWarnings = this.drawEdges(canvas, nodePositions, boxWidth);

		// Phase 8: Assemble final output with title, canvas, and any warnings
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

	/**
	 * Computes the optimal box width for the diagram.
	 *
	 * The algorithm balances several constraints:
	 * 1. Boxes must be wide enough to fit labels (with some truncation allowed)
	 * 2. All boxes in a row must fit within the terminal width
	 * 3. There must be spacing between boxes for visual separation
	 *
	 * @param maxLayerSize - Maximum number of nodes in any single layer
	 * @returns Optimal box width, or null if layout is impossible
	 */
	private computeBoxWidth(maxLayerSize: number): number | null {
		// Find the longest label (capped at MAX_LABEL to prevent extreme widths)
		const longestLabel = Math.min(
			MAX_LABEL,
			Math.max(...this.diagram.nodes.map((node) => node.label.length)),
		);

		// Natural width: label + 2 chars for box borders (│ on each side)
		const naturalWidth = Math.max(MIN_BOX_WIDTH, longestLabel + 2);

		// Maximum width considering terminal constraints
		const maxAllowedWidth = Math.min(MAX_BOX_WIDTH, this.width);

		// Calculate space needed for gaps between boxes
		const spacingWidth = Math.max(0, maxLayerSize - 1) * H_SPACING;

		// Available width for boxes after subtracting spacing
		const available = maxAllowedWidth - spacingWidth;

		// Width per box if distributed evenly
		const perBox = Math.floor(available / maxLayerSize);

		// If boxes can't even fit at minimum width, graphical layout is impossible
		if (perBox < MIN_BOX_WIDTH) {
			return null;
		}

		// Use the smaller of natural width and available per-box width
		return Math.min(naturalWidth, perBox);
	}

	/**
	 * Draws a single node box on the canvas.
	 *
	 * Box structure (3 lines):
	 * ```
	 * ┌────────┐  <- top border
	 * │ Label  │  <- label (centered, may be truncated)
	 * └────────┘  <- bottom border
	 * ```
	 *
	 * @param canvas - 2D character array to draw on
	 * @param x - Left edge X coordinate
	 * @param y - Top edge Y coordinate
	 * @param boxWidth - Total box width including borders
	 * @param label - Text to display inside the box
	 */
	private drawBox(
		canvas: string[][],
		x: number,
		y: number,
		boxWidth: number,
		label: string,
	): void {
		// Inner width is box width minus the two border characters
		const innerWidth = boxWidth - 2;

		// Truncate label if needed and center it within the inner width
		const truncated = truncateLabel(label, innerWidth);
		const paddedLabel = centerText(truncated, innerWidth);

		// Build the three lines of the box using Unicode box-drawing chars
		const top = `┌${"─".repeat(innerWidth)}┐`;
		const mid = `│${paddedLabel}│`;
		const bottom = `└${"─".repeat(innerWidth)}┘`;

		// Write each line to the canvas, character by character
		[top, mid, bottom].forEach((line, offset) => {
			const row = canvas[y + offset];
			if (!row) {
				return;
			}
			for (let i = 0; i < boxWidth; i++) {
				row[x + i] = line[i];
			}
		});
	}

	/**
	 * Draws edges between nodes using L-shaped routing.
	 *
	 * Edge routing strategy:
	 * 1. Exit from bottom center of source box
	 * 2. Go down to midpoint between layers
	 * 3. Turn horizontally toward target
	 * 4. Go to position above target
	 * 5. Turn down and draw arrowhead
	 *
	 * Visual example:
	 * ```
	 * ┌──────┐
	 * │Source│
	 * └──────┘
	 *     │      <- vertical segment from source
	 *     └────┐ <- L-turn at midpoint
	 *          │ <- vertical segment to target
	 *          ▼ <- arrowhead
	 * ┌────────┐
	 * │ Target │
	 * └────────┘
	 * ```
	 *
	 * @param canvas - 2D character array to draw on
	 * @param nodePositions - Map of node ID to box top-left coordinates
	 * @param boxWidth - Width of each box (for center calculation)
	 * @returns Array of warning messages for edges that couldn't be drawn
	 */
	private drawEdges(
		canvas: string[][],
		nodePositions: Map<string, { x: number; y: number }>,
		boxWidth: number,
	): string[] {
		const warnings: string[] = [];

		for (const edge of this.diagram.edges) {
			const from = nodePositions.get(edge.from);
			const to = nodePositions.get(edge.to);

			// Skip edges with missing endpoints (shouldn't happen with valid input)
			if (!from || !to) {
				warnings.push(`Skipped edge ${edge.from} -> ${edge.to} (node missing)`);
				continue;
			}

			// Only draw forward (downward) edges; back-edges would create visual clutter
			if (to.y <= from.y) {
				warnings.push(
					`Skipped edge ${edge.from} -> ${edge.to} (non-forward edge not drawn)`,
				);
				continue;
			}

			// Calculate edge endpoints at center of boxes
			const startX = from.x + Math.floor(boxWidth / 2);
			const startY = from.y + BOX_HEIGHT; // Just below source box
			const endX = to.x + Math.floor(boxWidth / 2);
			const endY = to.y - 1; // Just above target box

			// Midpoint Y for the horizontal segment
			const midY = Math.floor((startY + endY) / 2);

			// Draw vertical segment from source down to midpoint
			for (let y = startY; y < midY; y++) {
				setChar(canvas, startX, y, "│");
			}

			// Draw the L-turn at midpoint (corner depends on direction)
			const turnChar = startX <= endX ? "└" : "┘";
			setChar(canvas, startX, midY, turnChar);

			// Draw horizontal segment from source column to target column
			const step = startX <= endX ? 1 : -1;
			for (let x = startX + step; step === 1 ? x < endX : x > endX; x += step) {
				setChar(canvas, x, midY, "─");
			}

			// Draw the second L-turn above target
			const corner = startX <= endX ? "┐" : "┌";
			setChar(canvas, endX, midY, corner);

			// Draw vertical segment from midpoint down to arrowhead
			for (let y = midY + 1; y < endY; y++) {
				setChar(canvas, endX, y, "│");
			}

			// Draw the arrowhead pointing down into target box
			const arrowHead = "▼";
			setChar(canvas, endX, endY, arrowHead);

			// If edge has a label, write it along the horizontal segment
			if (edge.label) {
				this.writeLabel(canvas, edge.label, startX, endX, midY - 1);
			}
		}

		return warnings;
	}

	/**
	 * Writes an edge label above the horizontal edge segment.
	 *
	 * Labels are placed on the line above the horizontal segment to avoid
	 * overwriting the edge itself. If there isn't enough horizontal space
	 * for the label, it's truncated.
	 *
	 * @param canvas - 2D character array to draw on
	 * @param label - Edge annotation text
	 * @param startX - X coordinate of edge start
	 * @param endX - X coordinate of edge end
	 * @param y - Y coordinate for label (one above the horizontal segment)
	 */
	private writeLabel(
		canvas: string[][],
		label: string,
		startX: number,
		endX: number,
		y: number,
	): void {
		// Skip if label would be above the canvas
		if (y < 0) {
			return;
		}

		const minX = Math.min(startX, endX);
		const maxX = Math.max(startX, endX);

		// Need at least 4 chars of horizontal space for a meaningful label
		if (maxX - minX < 4) {
			return;
		}

		// Truncate label to fit available space (minus margins)
		const text = truncateLabel(label, maxX - minX - 2);

		// Write label characters starting after the first edge position
		const offsetStart = minX + 1;
		for (let i = 0; i < text.length; i++) {
			setChar(canvas, offsetStart + i, y, text[i]);
		}
	}

	/**
	 * Generates a text-only fallback when graphical rendering fails.
	 *
	 * This is used when:
	 * - The diagram is too wide for the terminal
	 * - The graph contains cycles
	 * - Layout calculation fails for other reasons
	 *
	 * The fallback provides a structured list of nodes and edges,
	 * ensuring the diagram content is still accessible.
	 */
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

/**
 * Assigns nodes to vertical layers using Kahn's algorithm for topological sort.
 *
 * ## Algorithm Overview
 *
 * This is a modified topological sort that assigns layer numbers instead of
 * producing a linear ordering. The layer number represents the longest path
 * from any source node to this node.
 *
 * 1. **Initialize**: Count incoming edges (in-degree) for each node
 * 2. **Seed**: Start with nodes that have no incoming edges (sources)
 * 3. **Process**: For each node, update its children's layers to be at least
 *    one greater than the current node's layer
 * 4. **Handle Cycles**: Any nodes not reached are placed in additional layers
 *
 * ## Complexity
 *
 * - Time: O(V + E) where V = nodes, E = edges
 * - Space: O(V) for the in-degree and layer maps
 *
 * @param diagram - Parsed Mermaid diagram with nodes and edges
 * @returns Map from node ID to layer number, or null on failure
 */
function assignLayers(diagram: ParsedMermaid): Map<string, number> | null {
	// Step 1: Calculate in-degree (number of incoming edges) for each node
	const indegree = new Map<string, number>();
	for (const node of diagram.nodes) {
		indegree.set(node.id, 0);
	}
	for (const edge of diagram.edges) {
		// Skip self-loops as they don't affect layering
		if (edge.from === edge.to) {
			continue;
		}
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	}

	// Step 2: Initialize layer assignments and processing queue
	const layerMap = new Map<string, number>();
	const queue: MermaidNode[] = [];

	// Source nodes (in-degree 0) start at layer 0
	for (const node of diagram.nodes) {
		if ((indegree.get(node.id) ?? 0) === 0) {
			queue.push(node);
			if (!layerMap.has(node.id)) {
				layerMap.set(node.id, 0);
			}
		}
	}

	// Step 3: Process queue using BFS-like traversal
	// Use cursor instead of shift() for O(1) dequeue
	let cursor = 0;
	while (cursor < queue.length) {
		const node = queue[cursor];
		cursor += 1;
		const currentLayer = layerMap.get(node.id) ?? 0;

		// Process all outgoing edges from this node
		for (const edge of diagram.edges) {
			if (edge.from !== node.id) {
				continue;
			}

			// Child's layer must be at least one more than parent's
			// Use max to handle diamond dependencies correctly
			const nextLayer = Math.max(currentLayer + 1, layerMap.get(edge.to) ?? 0);
			layerMap.set(edge.to, nextLayer);

			// Decrement in-degree and add to queue when all parents processed
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

	// Step 4: Handle nodes not reached (part of cycles or disconnected)
	// Place them in layers after all reachable nodes
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

/**
 * Groups nodes into arrays by their layer assignment.
 *
 * @param nodes - All nodes in the diagram
 * @param layerMap - Map from node ID to layer number
 * @returns 2D array where index is layer number, value is nodes in that layer
 */
function groupByLayer(
	nodes: MermaidNode[],
	layerMap: Map<string, number>,
): MermaidNode[][] {
	const layers: MermaidNode[][] = [];

	// Distribute nodes into layer buckets
	for (const node of nodes) {
		const layer = layerMap.get(node.id) ?? 0;
		if (!layers[layer]) {
			layers[layer] = [];
		}
		layers[layer].push(node);
	}

	// Sort nodes within each layer by parse order for stable rendering
	return layers.map((layer) => layer.sort((a, b) => a.order - b.order));
}

/**
 * Parses Mermaid graph syntax into an intermediate representation.
 *
 * ## Supported Syntax
 *
 * - Graph declaration: `graph TD`, `graph LR`, etc.
 * - Node declarations: `A[Label]`, `B(Label)`, `C{Label}`, `D((Label))`
 * - Edge declarations: `A --> B`, `A -.-> B`, `A ==> B`
 * - Edge labels: `A -->|label| B`
 * - Comments: `%% comment text`
 *
 * ## Limitations
 *
 * - Subgraphs are recognized but flattened (nodes extracted, grouping ignored)
 * - Style definitions are skipped
 * - Click handlers are skipped
 *
 * @param source - Raw Mermaid diagram source
 * @returns Parsed diagram or null if parsing fails
 */
function parseMermaid(source: string): ParsedMermaid | null {
	// Preprocess: split lines, remove comments (%%...), and filter empties
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
	let order = 0; // Tracks parse order for stable positioning

	for (const line of cleanedLines) {
		// Parse graph declaration for orientation
		if (line.toLowerCase().startsWith("graph")) {
			orientation = parseOrientation(line) ?? orientation;
			continue;
		}

		// Skip unsupported directives (subgraphs, styles, etc.)
		if (/^(subgraph|end|classDef|style|linkStyle|click)/i.test(line)) {
			continue;
		}

		// Try to parse as an edge (contains a connector like -->)
		const connector = findConnector(line);
		if (connector) {
			const { left, right, label, reversed } = splitEdge(line, connector);
			const startToken = parseNodeToken(left);
			const endToken = parseNodeToken(right);

			if (!startToken || !endToken) {
				continue;
			}

			// Handle reversed edges (arrows pointing left)
			const from = reversed ? endToken.id : startToken.id;
			const to = reversed ? startToken.id : endToken.id;

			// Register both nodes (idempotent if already exists)
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

		// Try to parse as a standalone node declaration
		const token = parseNodeToken(line);
		if (token) {
			ensureNode(nodes, token.id, token.label, order++);
		}
	}

	// Require at least some content to be parsed
	if (!nodes.size && !edges.length) {
		return null;
	}

	// Ensure nodes referenced by edges exist (handles implicit nodes)
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

/**
 * Registers a node if it doesn't already exist.
 *
 * This function is idempotent - calling it multiple times with the same ID
 * will not overwrite the existing node. This allows edges to reference
 * nodes before they're explicitly declared.
 *
 * @param nodes - Map to store nodes
 * @param id - Unique node identifier
 * @param label - Display label for the node
 * @param order - Parse order for stable positioning
 */
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

/**
 * Extracts graph orientation from a graph declaration line.
 *
 * @param line - Line containing "graph XX" declaration
 * @returns Orientation enum value, or null if not found
 */
function parseOrientation(line: string): Orientation | null {
	const match = line.match(/graph\s+(TD|TB|BT|LR|RL)/i);
	if (match) {
		return match[1].toUpperCase() as Orientation;
	}
	return null;
}

/**
 * Finds the first edge connector token in a line.
 *
 * Uses first-match semantics with the CONNECTORS array ordered by
 * specificity to handle overlapping patterns correctly.
 *
 * @param line - Line to search for connectors
 * @returns Connector string if found, null otherwise
 */
function findConnector(line: string): string | null {
	for (const token of CONNECTORS) {
		const index = line.indexOf(token);
		if (index >= 0) {
			return token;
		}
	}
	return null;
}

/**
 * Splits an edge declaration into its components.
 *
 * Handles edge labels in the format: `A -->|label| B`
 * Also detects reversed edges (arrows pointing left like `<--`)
 *
 * @param line - Full edge declaration line
 * @param connector - The connector token found in the line
 * @returns Object with left node, right node, optional label, and reversal flag
 */
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

	// Extract edge label if present (format: |label|)
	let label: string | undefined;
	if (right.startsWith("|")) {
		const closing = right.indexOf("|", 1);
		if (closing > 1) {
			label = right.slice(1, closing).trim();
			right = right.slice(closing + 1).trim();
		}
	}

	// Arrows starting with < indicate reversed direction
	const reversed = connector.startsWith("<");
	return { left, right, label, reversed };
}

/**
 * Parses a node token to extract ID and label.
 *
 * Supports multiple node shapes:
 * - `A[label]` - Rectangle
 * - `B(label)` - Rounded rectangle (stadium)
 * - `C{label}` - Diamond (decision)
 * - `D((label))` - Circle
 *
 * If no label is specified, the ID is used as the label.
 *
 * @param token - Node declaration token
 * @returns Object with id and label, or null if invalid
 */
function parseNodeToken(token: string): { id: string; label: string } | null {
	// Node ID must start with alphanumeric and can contain _:-
	const idMatch = token.match(/^[A-Za-z0-9_:-]+/);
	if (!idMatch) {
		return null;
	}

	const id = idMatch[0];
	const remainder = token.slice(id.length).trim();

	// No label specified - use ID as label
	if (!remainder) {
		return { id, label: id };
	}

	// Match various bracket types for labels
	const labelMatch = remainder.match(
		/^(?:\[(.+?)\]|\((.+?)\)|\{(.+?)\}|\(\((.+?)\)\))/,
	);
	if (labelMatch) {
		// Find the first non-undefined capture group
		const label = labelMatch.slice(1).find((value) => value !== undefined);
		return { id, label: (label ?? id).trim() };
	}

	return { id, label: id };
}

/**
 * Truncates a label to fit within a given width.
 *
 * If truncation is needed, an ellipsis (…) is appended.
 * The result is padded with spaces to exactly fill the width.
 *
 * @param label - Text to truncate
 * @param width - Maximum width in characters
 * @returns Label padded or truncated to exact width
 */
function truncateLabel(label: string, width: number): string {
	if (label.length <= width) {
		return label.padEnd(width, " ");
	}
	if (width <= 1) {
		return label.slice(0, width);
	}
	// Leave room for ellipsis character
	return `${label.slice(0, width - 1)}…`;
}

/**
 * Centers text within a given width using space padding.
 *
 * If the text is longer than the width, it's returned unchanged.
 * Extra padding is distributed evenly, with remainder on the right.
 *
 * @param text - Text to center
 * @param width - Total width to center within
 * @returns Centered text with space padding
 */
function centerText(text: string, width: number): string {
	if (text.length >= width) {
		return text;
	}
	const totalPadding = width - text.length;
	const left = Math.floor(totalPadding / 2);
	const right = totalPadding - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

/**
 * Safely sets a character on the canvas with bounds checking.
 *
 * This function silently ignores out-of-bounds writes, which is useful
 * for edge drawing where paths may extend beyond the visible area.
 *
 * @param canvas - 2D character array
 * @param x - Column index
 * @param y - Row index
 * @param char - Character to write
 */
function setChar(canvas: string[][], x: number, y: number, char: string): void {
	const row = canvas[y];
	if (!row || !row[x]) {
		return;
	}
	row[x] = char;
}
